// Package storage manages where artifacts are stored: the settings edited in
// Admin → Storage (system_settings key "storage", S3 secret encrypted with
// QATLAS_MASTER_KEY), the Registry that hot-swaps the active store in every
// process (LISTEN qatlas_settings), the admin endpoints and the storage
// migration job.
//
// Precedence: QATLAS_STORAGE set in the environment → the environment wins
// (source "env", the UI is read-only); otherwise the database settings
// (source "database"); otherwise local storage (source "default"). The local
// store is always available, so artifacts written locally stay readable after
// switching to S3; every artifact row records its backend (artifacts.storage).
package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// Channel is the NOTIFY channel announcing settings changes. Payloads:
// PayloadStorage (reload the storage settings) and PayloadMigration
// (storage migration progress; informational).
const Channel = "qatlas_settings"

// NOTIFY payloads on Channel.
const (
	PayloadStorage   = "storage"
	PayloadMigration = "storage_migration"
)

// Sources of the active configuration (StorageSettings.source).
const (
	SourceDefault  = "default"
	SourceDatabase = "database"
	SourceEnv      = "env"
)

const (
	settingsKey = "storage"
	backfillKey = "artifacts_storage_backfill"
)

// s3Value is the stored S3 configuration (everything but the secret).
type s3Value struct {
	Endpoint       string `json:"endpoint"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	AccessKeyID    string `json:"access_key_id"`
	Prefix         string `json:"prefix"`
	ForcePathStyle bool   `json:"force_path_style"`
}

// settingsValue is system_settings.value of key "storage".
type settingsValue struct {
	Backend string   `json:"backend"`
	S3      *s3Value `json:"s3,omitempty"`
}

// stored is the "storage" row.
type stored struct {
	Value           settingsValue
	SecretEnc       []byte
	SecretUpdatedAt *time.Time
	UpdatedAt       time.Time
	UpdatedBy       *uuid.UUID
	UpdatedByName   *string
	UpdatedByEmail  *string
}

// loadStored reads the storage settings row; (nil, nil) when there is none.
func loadStored(ctx context.Context, q db.Querier, forUpdate bool) (*stored, error) {
	sql := `
		SELECT s.value, s.secret_enc, s.secret_updated_at, s.updated_at, s.updated_by, u.name, u.email
		FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by
		WHERE s.key = $1`
	if forUpdate {
		sql += ` FOR UPDATE OF s`
	}
	var (
		st  stored
		raw []byte
	)
	err := q.QueryRow(ctx, sql, settingsKey).Scan(&raw, &st.SecretEnc, &st.SecretUpdatedAt, &st.UpdatedAt, &st.UpdatedBy, &st.UpdatedByName, &st.UpdatedByEmail)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &st.Value); err != nil {
		return nil, fmt.Errorf("storage settings: %w", err)
	}
	if st.Value.Backend != config.StorageS3 {
		st.Value.Backend = config.StorageLocal
	}
	return &st, nil
}

// storedVersion returns updated_at of the storage row (zero when none).
func storedVersion(ctx context.Context, q db.Querier) (time.Time, bool, error) {
	var t time.Time
	err := q.QueryRow(ctx, `SELECT updated_at FROM system_settings WHERE key = $1`, settingsKey).Scan(&t)
	if db.IsNoRows(err) {
		return time.Time{}, false, nil
	}
	return t, err == nil, err
}

// isUndefinedTable reports a missing table (migrations not applied yet).
func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// s3Config builds the S3 configuration from the stored row (decrypting the secret).
func (st *stored) s3Config(masterKey []byte) (config.S3Config, error) {
	v := st.Value.S3
	if v == nil {
		return config.S3Config{}, errors.New("no S3 settings stored")
	}
	cfg := v.config("")
	if len(st.SecretEnc) == 0 {
		return cfg, errors.New("no S3 secret key stored")
	}
	if len(masterKey) == 0 {
		return cfg, errors.New("QATLAS_MASTER_KEY is not set, the stored S3 secret key cannot be decrypted")
	}
	pt, err := secrets.Open(masterKey, st.SecretEnc)
	if err != nil {
		return cfg, fmt.Errorf("stored S3 secret key: %w", err)
	}
	cfg.SecretKey = string(pt)
	return cfg, nil
}

func (v s3Value) config(secret string) config.S3Config {
	return config.S3Config{
		Endpoint: v.Endpoint, Region: v.Region, Bucket: v.Bucket,
		AccessKey: v.AccessKeyID, SecretKey: secret,
		ForcePathStyle: v.ForcePathStyle, Prefix: v.Prefix,
	}
}

// ------------------------------------------------------------------ input

// Input is the OpenAPI StorageSettingsInput (PUT and POST /test).
type Input struct {
	Backend string   `json:"backend"`
	S3      *S3Input `json:"s3"`
}

// S3Input is StorageSettingsInput.s3. An omitted or empty SecretAccessKey
// keeps the stored secret.
type S3Input struct {
	Endpoint        string  `json:"endpoint"`
	Region          string  `json:"region"`
	Bucket          string  `json:"bucket"`
	AccessKeyID     string  `json:"access_key_id"`
	SecretAccessKey *string `json:"secret_access_key"`
	Prefix          string  `json:"prefix"`
	ForcePathStyle  *bool   `json:"force_path_style"`
}

var (
	regionRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	accessKeyRe = regexp.MustCompile(`^[\x21-\x7e]{3,128}$`) // printable ASCII, no spaces
)

// resolved is a validated Input: the backend plus the S3 configuration to use
// (with the secret: given or stored), or nil when no S3 is configured.
type resolved struct {
	backend        string
	s3             *s3Value
	secret         string
	secretReplaced bool // a new secret was given
	s3Given        bool // the input contained an s3 block
}

// resolve validates in against the stored settings (cur may be nil) and
// returns 422 validation_failed with one detail per field problem.
func resolve(in Input, cur *stored, masterKey []byte) (*resolved, error) {
	var details []httpx.FieldError
	add := func(path, msg string) { details = append(details, httpx.Field(path, msg)) }
	out := &resolved{backend: strings.ToLower(strings.TrimSpace(in.Backend))}
	switch out.backend {
	case config.StorageLocal, config.StorageS3:
	case "":
		add("backend", "Choose local or s3")
	default:
		add("backend", "Must be local or s3")
	}

	if in.S3 != nil {
		out.s3Given = true
		v := &s3Value{
			Endpoint:       strings.TrimRight(strings.TrimSpace(in.S3.Endpoint), "/"),
			Region:         strings.TrimSpace(in.S3.Region),
			Bucket:         strings.TrimSpace(in.S3.Bucket),
			AccessKeyID:    strings.TrimSpace(in.S3.AccessKeyID),
			Prefix:         strings.Trim(strings.TrimSpace(in.S3.Prefix), "/"),
			ForcePathStyle: true,
		}
		if v.Region == "" {
			v.Region = config.DefaultS3Region
		}
		if in.S3.ForcePathStyle != nil {
			v.ForcePathStyle = *in.S3.ForcePathStyle
		}
		switch u, err := url.Parse(v.Endpoint); {
		case v.Endpoint == "":
			add("s3.endpoint", "Endpoint is required")
		case err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
			(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.User != nil:
			add("s3.endpoint", "Must be an http(s) URL with scheme and host only, e.g. https://garage.example.com")
		}
		if !regionRe.MatchString(v.Region) {
			add("s3.region", "Letters, digits, '-', '_' and '.' only (Garage: the s3_region of garage.toml, usually \"garage\")")
		}
		switch {
		case v.Bucket == "":
			add("s3.bucket", "Bucket is required")
		case !config.ValidBucketName(v.Bucket):
			add("s3.bucket", "Not a valid bucket name (3-63 characters: a-z, 0-9, '.', '-')")
		}
		switch {
		case v.AccessKeyID == "":
			add("s3.access_key_id", "Access key ID is required")
		case !accessKeyRe.MatchString(v.AccessKeyID):
			add("s3.access_key_id", "3-128 printable characters without spaces")
		}
		if v.Prefix != "" {
			for _, seg := range strings.Split(v.Prefix, "/") {
				if seg == "" || seg == "." || seg == ".." || strings.ContainsAny(seg, "\\\x00") {
					add("s3.prefix", "Slash-separated names without empty, '.' or '..' segments")
					break
				}
			}
		}
		secret := ""
		if in.S3.SecretAccessKey != nil {
			secret = *in.S3.SecretAccessKey
		}
		switch {
		case secret != "":
			if len(secret) > 256 || strings.ContainsFunc(secret, func(r rune) bool { return r <= ' ' || r == 0x7f }) {
				add("s3.secret_access_key", "At most 256 characters without spaces or control characters")
			}
			out.secret, out.secretReplaced = secret, true
		case cur != nil && len(cur.SecretEnc) > 0:
			old, err := cur.s3Config(masterKey)
			if err != nil {
				add("s3.secret_access_key", "The stored secret cannot be used ("+err.Error()+"); enter it again")
			} else {
				out.secret = old.SecretKey
			}
		default:
			add("s3.secret_access_key", "Secret access key is required")
		}
		out.s3 = v
	} else if cur != nil && cur.Value.S3 != nil {
		// No s3 block: keep the stored S3 settings (e.g. switching back to local
		// keeps them, so artifacts in S3 stay readable and can be migrated).
		v := *cur.Value.S3
		out.s3 = &v
		cfg, err := cur.s3Config(masterKey)
		if err != nil && out.backend == config.StorageS3 {
			add("s3.secret_access_key", "The stored secret cannot be used ("+err.Error()+"); enter it again")
		}
		out.secret = cfg.SecretKey
	} else if out.backend == config.StorageS3 {
		add("s3", "S3 settings are required to use S3 storage")
	}

	if len(details) > 0 {
		return nil, httpx.Unprocessable("Invalid storage settings", details...)
	}
	return out, nil
}

// changedFields lists what an update changes (for the audit log; never values of secrets).
func changedFields(cur *stored, r *resolved) []string {
	var old settingsValue
	if cur != nil {
		old = cur.Value
	} else {
		old.Backend = config.StorageLocal
	}
	var out []string
	if old.Backend != r.backend {
		out = append(out, "backend")
	}
	var a, b s3Value
	if old.S3 != nil {
		a = *old.S3
	}
	if r.s3 != nil {
		b = *r.s3
	}
	for _, f := range []struct {
		name string
		diff bool
	}{
		{"s3.endpoint", a.Endpoint != b.Endpoint},
		{"s3.region", a.Region != b.Region},
		{"s3.bucket", a.Bucket != b.Bucket},
		{"s3.access_key_id", a.AccessKeyID != b.AccessKeyID},
		{"s3.prefix", a.Prefix != b.Prefix},
		{"s3.force_path_style", a.ForcePathStyle != b.ForcePathStyle},
	} {
		if f.diff {
			out = append(out, f.name)
		}
	}
	if r.secretReplaced {
		out = append(out, "s3.secret_access_key")
	}
	return out
}

// StoredS3Config returns the S3 configuration saved in Admin → Storage (with
// the decrypted secret); ok=false when none is stored. For the artifacts CLI.
func StoredS3Config(ctx context.Context, q db.Querier, masterKey []byte) (config.S3Config, bool, error) {
	row, err := loadStored(ctx, q, false)
	if isUndefinedTable(err) {
		return config.S3Config{}, false, nil
	}
	if err != nil || row == nil || row.Value.S3 == nil {
		return config.S3Config{}, false, err
	}
	cfg, err := row.s3Config(masterKey)
	return cfg, err == nil, err
}
