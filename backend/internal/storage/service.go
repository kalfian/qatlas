package storage

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// Audit actions.
const (
	ActionUpdate  = "settings.storage.update"
	ActionMigrate = "settings.storage.migrate"
)

// CodeEnvOverride is the 409 error code of PUT while QATLAS_STORAGE is set.
const CodeEnvOverride = "env_override"

// Service implements /admin/settings/storage (admin, session only).
type Service struct {
	pool   *pgxpool.Pool
	reg    *Registry
	cfg    *config.Config
	enq    jobs.StorageMigrationEnqueuer // nil: migrations cannot be started
	logger *slog.Logger
}

// NewService builds the service. enq may be nil (POST /migrate then answers 503).
func NewService(pool *pgxpool.Pool, reg *Registry, cfg *config.Config, enq jobs.StorageMigrationEnqueuer, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, reg: reg, cfg: cfg, enq: enq, logger: logger}
}

// Routes mounts the endpoints (inside the authenticated group).
func (s *Service) Routes(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireSession)
		r.Get("/admin/settings/storage", httpx.Handle(s.handleGet))
		r.Put("/admin/settings/storage", httpx.Handle(s.handlePut))
		r.Post("/admin/settings/storage/test", httpx.Handle(s.handleTest))
		r.Post("/admin/settings/storage/migrate", httpx.Handle(s.handleMigrate))
	})
}

// ------------------------------------------------------------------ DTOs

// Settings is the OpenAPI StorageSettings.
type Settings struct {
	ActiveBackend string         `json:"active_backend"`
	Source        string         `json:"source"`
	EnvOverride   bool           `json:"env_override"`
	S3            S3Settings     `json:"s3"`
	Artifacts     ArtifactCounts `json:"artifacts"`
	Migration     *Migration     `json:"migration"`
	UpdatedAt     *time.Time     `json:"updated_at"`
	UpdatedBy     *auth.UserRef  `json:"updated_by"`
	// Warning explains why the configured storage is not (fully) in use, e.g.
	// S3 selected but unreachable at startup (new artifacts go to local).
	Warning *string `json:"warning"`
}

// S3Settings is StorageSettings.s3 (never the secret).
type S3Settings struct {
	Endpoint        string     `json:"endpoint"`
	Region          string     `json:"region"`
	Bucket          string     `json:"bucket"`
	AccessKeyID     string     `json:"access_key_id"`
	Prefix          string     `json:"prefix"`
	ForcePathStyle  bool       `json:"force_path_style"`
	SecretSet       bool       `json:"secret_set"`
	SecretUpdatedAt *time.Time `json:"secret_updated_at"`
}

// ArtifactCounts is StorageSettings.artifacts (non-purged artifacts per backend).
type ArtifactCounts struct {
	Local      int64 `json:"local"`
	S3         int64 `json:"s3"`
	BytesLocal int64 `json:"bytes_local"`
	BytesS3    int64 `json:"bytes_s3"`
}

// TestResult is the OpenAPI StorageTestResult.
type TestResult struct {
	OK        bool        `json:"ok"`
	Message   string      `json:"message"`
	LatencyMS int64       `json:"latency_ms"`
	Checks    []TestCheck `json:"checks"`
}

// TestCheck is one StorageTestResult check.
type TestCheck struct {
	Name      string `json:"name"`
	OK        bool   `json:"ok"`
	Message   string `json:"message"`
	LatencyMS int64  `json:"latency_ms"`
}

// MigrateInput is the POST /migrate body.
type MigrateInput struct {
	DeleteSource bool `json:"delete_source"`
}

func requireAdmin(actor *auth.Actor) error {
	if !actor.IsAdmin() {
		return httpx.Forbidden("Only admins can do this")
	}
	return nil
}

// ------------------------------------------------------------------ GET

// Get returns the storage settings (admin only).
func (s *Service) Get(ctx context.Context, actor *auth.Actor) (Settings, error) {
	if err := requireAdmin(actor); err != nil {
		return Settings{}, err
	}
	return s.settings(ctx)
}

func (s *Service) settings(ctx context.Context) (Settings, error) {
	st := s.reg.Status()
	out := Settings{
		ActiveBackend: st.Active,
		Source:        st.Source,
		EnvOverride:   st.Source == SourceEnv,
		S3:            S3Settings{Region: config.DefaultS3Region, ForcePathStyle: true},
	}
	if st.Warning != "" {
		w := st.Warning
		out.Warning = &w
	}
	row, err := loadStored(ctx, s.pool, false)
	if err != nil && !isUndefinedTable(err) {
		return out, err
	}
	switch {
	case out.EnvOverride && s.cfg != nil:
		e := s.cfg.S3
		out.S3 = S3Settings{Endpoint: e.Endpoint, Region: e.Region, Bucket: e.Bucket, AccessKeyID: e.AccessKey,
			Prefix: e.Prefix, ForcePathStyle: e.ForcePathStyle, SecretSet: e.SecretKey != ""}
	case row != nil:
		if v := row.Value.S3; v != nil {
			out.S3 = S3Settings{Endpoint: v.Endpoint, Region: v.Region, Bucket: v.Bucket, AccessKeyID: v.AccessKeyID,
				Prefix: v.Prefix, ForcePathStyle: v.ForcePathStyle}
		}
		out.S3.SecretSet = len(row.SecretEnc) > 0
		out.S3.SecretUpdatedAt = auth.UTCPtr(row.SecretUpdatedAt)
		out.UpdatedAt = auth.UTCPtr(&row.UpdatedAt)
		if row.UpdatedBy != nil {
			ref := auth.NewUserRef(row.UpdatedBy, row.UpdatedByName, row.UpdatedByEmail)
			out.UpdatedBy = &ref
		}
	}
	rows, err := s.pool.Query(ctx, `
		SELECT storage, count(*), COALESCE(sum(size_bytes), 0)::bigint
		FROM artifacts WHERE purged_at IS NULL GROUP BY storage`)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var (
			backend string
			n, b    int64
		)
		if err := rows.Scan(&backend, &n, &b); err != nil {
			rows.Close()
			return out, err
		}
		switch backend {
		case config.StorageLocal:
			out.Artifacts.Local, out.Artifacts.BytesLocal = n, b
		case config.StorageS3:
			out.Artifacts.S3, out.Artifacts.BytesS3 = n, b
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	if out.Migration, err = latestMigration(ctx, s.pool); err != nil {
		return out, err
	}
	return out, nil
}

// ------------------------------------------------------------------ PUT

// Update validates, probes and saves the storage settings, then switches this
// process to them and notifies the others. Nothing is saved when the probe fails.
func (s *Service) Update(ctx context.Context, actor *auth.Actor, in Input) (Settings, error) {
	if err := requireAdmin(actor); err != nil {
		return Settings{}, err
	}
	if s.reg.EnvOverride() {
		return Settings{}, httpx.NewError(http.StatusConflict, CodeEnvOverride,
			"Artifact storage is configured by the QATLAS_STORAGE environment variable on this server. "+
				"Remove QATLAS_STORAGE (and the QATLAS_S3_* variables) from the server and worker environment and restart them to manage storage here.")
	}
	masterKey := s.masterKey()
	cur, err := loadStored(ctx, s.pool, false)
	if err != nil {
		return Settings{}, err
	}
	res, err := resolve(in, cur, masterKey)
	if err != nil {
		return Settings{}, err
	}
	if res.secretReplaced && len(masterKey) != secrets.KeySize {
		return Settings{}, errors.New("QATLAS_MASTER_KEY is required to store the S3 secret key")
	}

	// Build and probe before anything is saved.
	next := &state{source: SourceDatabase, set: artifacts.StoreSet{Active: res.backend, Local: s.reg.Local()}}
	if res.s3 != nil {
		s3store, probeStore, err := buildS3(res.s3.config(res.secret))
		switch {
		case err != nil && (res.s3Given || res.backend == config.StorageS3):
			return Settings{}, httpx.Unprocessable("Invalid S3 settings: "+err.Error(), httpx.Field("s3", err.Error()))
		case err == nil && (res.s3Given || res.backend == config.StorageS3):
			if err := probeFailure(ctx, probeStore, s.reg.opts.ProbeTimeout); err != nil {
				return Settings{}, err
			}
			next.set.S3 = s3store
		case err == nil:
			next.set.S3 = s3store // kept unchanged (switching to local): reads only, not probed
		}
	}
	if res.backend == config.StorageLocal {
		if err := probeFailure(ctx, s.reg.Local(), s.reg.opts.ProbeTimeout); err != nil {
			return Settings{}, err
		}
	}

	changed := changedFields(cur, res)
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		locked, err := loadStored(ctx, tx, true)
		if err != nil {
			return err
		}
		var (
			secretEnc       []byte
			secretUpdatedAt *time.Time
		)
		if locked != nil {
			secretEnc, secretUpdatedAt = locked.SecretEnc, locked.SecretUpdatedAt
		}
		if res.secretReplaced {
			if secretEnc, err = secrets.Seal(masterKey, []byte(res.secret)); err != nil {
				return err
			}
			now := time.Now()
			secretUpdatedAt = &now
		}
		if res.s3 == nil {
			secretEnc, secretUpdatedAt = nil, nil
		}
		value, err := json.Marshal(settingsValue{Backend: res.backend, S3: res.s3})
		if err != nil {
			return err
		}
		uid := actor.User.ID
		if err := tx.QueryRow(ctx, `
			INSERT INTO system_settings AS s (key, value, secret_enc, secret_updated_at, updated_at, updated_by)
			VALUES ($1, $2, $3, $4, clock_timestamp(), $5)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret_enc = EXCLUDED.secret_enc,
				secret_updated_at = EXCLUDED.secret_updated_at, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
			RETURNING s.updated_at`, settingsKey, value, secretEnc, secretUpdatedAt, uid).Scan(&next.version); err != nil {
			return err
		}
		previous := config.StorageLocal
		if cur != nil {
			previous = cur.Value.Backend
		}
		if err := audit.Record(ctx, tx, actor, ActionUpdate, "settings", "storage", nil, audit.Meta{
			"backend":          res.backend,
			"previous_backend": previous,
			"changed":          changed,
			"secret_replaced":  res.secretReplaced,
		}); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, Channel, PayloadStorage)
		return err
	})
	if err != nil {
		return Settings{}, err
	}
	s.reg.install(next)
	return s.settings(ctx)
}

// probeFailure probes store and turns a failed check into 422
// validation_failed with the detail path "checks.<name>" (checks before it
// passed; the ones after it did not run).
func probeFailure(ctx context.Context, store artifacts.Store, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	checks := artifacts.Probe(pctx, store)
	if artifacts.ProbeError(checks) == nil {
		return nil
	}
	var details []httpx.FieldError
	first := ""
	for _, c := range checks {
		if c.OK || isSkipped(c) {
			continue
		}
		details = append(details, httpx.Field("checks."+c.Name, c.Message))
		if first == "" {
			first = c.Name + ": " + c.Message
		}
	}
	return httpx.Unprocessable("Storage connection check failed ("+first+"); nothing was saved", details...)
}

func isSkipped(c artifacts.ProbeCheck) bool {
	return !c.OK && c.Duration == 0 && c.Message == "Skipped: an earlier check failed"
}

func (s *Service) masterKey() []byte {
	if s.cfg == nil {
		return nil
	}
	return s.cfg.MasterKey
}

// ------------------------------------------------------------------ POST /test

// Test probes a configuration without saving it (omitted secret = the stored one).
func (s *Service) Test(ctx context.Context, actor *auth.Actor, in Input) (TestResult, error) {
	if err := requireAdmin(actor); err != nil {
		return TestResult{}, err
	}
	cur, err := loadStored(ctx, s.pool, false)
	if err != nil && !isUndefinedTable(err) {
		return TestResult{}, err
	}
	res, err := resolve(in, cur, s.masterKey())
	if err != nil {
		return TestResult{}, err
	}
	var store artifacts.Store = s.reg.Local()
	if res.backend == config.StorageS3 {
		_, probe, err := buildS3(res.s3.config(res.secret))
		if err != nil {
			return TestResult{}, httpx.Unprocessable("Invalid S3 settings: "+err.Error(), httpx.Field("s3", err.Error()))
		}
		store = probe
	}
	timeout := s.reg.opts.ProbeTimeout
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	checks := artifacts.Probe(pctx, store)
	out := TestResult{OK: true, Message: "All checks passed", LatencyMS: time.Since(start).Milliseconds(), Checks: []TestCheck{}}
	for _, c := range checks {
		out.Checks = append(out.Checks, TestCheck{Name: c.Name, OK: c.OK, Message: c.Message, LatencyMS: c.Duration.Milliseconds()})
	}
	if err := artifacts.ProbeError(checks); err != nil {
		out.OK, out.Message = false, err.Error()
	}
	return out, nil
}

// ------------------------------------------------------------------ POST /migrate

// StartMigration queues a job copying every artifact stored on the other
// backend into the active one. 409 while one is queued or running. Allowed
// under an environment override (it moves artifacts into the env backend).
// With nothing to move the migration is recorded as done (total 0) at once.
func (s *Service) StartMigration(ctx context.Context, actor *auth.Actor, in MigrateInput) (Settings, error) {
	if err := requireAdmin(actor); err != nil {
		return Settings{}, err
	}
	if s.enq == nil {
		return Settings{}, httpx.NewError(http.StatusServiceUnavailable, "unavailable", "Background jobs are not available on this server")
	}
	st := s.reg.Status()
	if st.Fallback {
		return Settings{}, httpx.Conflict("S3 storage is selected but currently unreachable, so new artifacts go to local storage. Fix the storage settings before migrating.")
	}
	to := st.Active
	from := config.StorageS3
	if to == config.StorageS3 {
		from = config.StorageLocal
	}
	if _, err := RecoverMigrations(ctx, s.pool); err != nil {
		s.logger.WarnContext(ctx, "storage migration recovery failed", "err", err)
	}
	conflict := httpx.Conflict("A storage migration is already queued or running")
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM storage_migrations WHERE status IN ('queued', 'running'))`).Scan(&active); err != nil {
			return err
		}
		if active {
			return conflict
		}
		total, err := artifacts.CountObjects(ctx, tx, from)
		if err != nil {
			return err
		}
		id := db.NewID()
		uid := actor.User.ID
		if total == 0 {
			// Nothing to move: done at once, no job.
			_, err = tx.Exec(ctx, `
				INSERT INTO storage_migrations (id, status, from_backend, to_backend, delete_source, created_by, started_at, finished_at)
				VALUES ($1, 'done', $2, $3, $4, $5, now(), now())`, id, from, to, in.DeleteSource, uid)
		} else {
			_, err = tx.Exec(ctx, `
				INSERT INTO storage_migrations (id, status, from_backend, to_backend, delete_source, total, created_by)
				VALUES ($1, 'queued', $2, $3, $4, $5, $6)`, id, from, to, in.DeleteSource, total, uid)
		}
		if err != nil {
			if db.IsUniqueViolation(err, "storage_migrations_active_key") {
				return conflict // a concurrent request won
			}
			return err
		}
		if total > 0 {
			jobID, err := s.enq.EnqueueStorageMigration(ctx, tx, id)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE storage_migrations SET job_id = $2 WHERE id = $1`, id, jobID); err != nil {
				return err
			}
		}
		if err := audit.Record(ctx, tx, actor, ActionMigrate, "settings", "storage", nil, audit.Meta{
			"from": from, "to": to, "delete_source": in.DeleteSource, "migration_id": id.String(), "total": total,
		}); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, Channel, PayloadMigration)
		return err
	})
	if err != nil {
		return Settings{}, err
	}
	return s.settings(ctx)
}

// ------------------------------------------------------------------ handlers

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.Get(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handlePut(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := requireAdmin(actor); err != nil {
		return err
	}
	var in Input
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Update(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleTest(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := requireAdmin(actor); err != nil {
		return err
	}
	var in Input
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Test(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleMigrate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := requireAdmin(actor); err != nil {
		return err
	}
	var in MigrateInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.StartMigration(r.Context(), actor, in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusAccepted, out)
	return nil
}
