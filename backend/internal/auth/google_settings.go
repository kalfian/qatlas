package auth

// Google sign-in settings (Admin → Google sign-in, /admin/settings/google-auth).
//
// Precedence: GOOGLE_CLIENT_ID set in the environment → the environment
// configuration (source "env", the endpoints answer 409 env_override for
// writes); otherwise the system_settings row "google_auth" (source
// "database"); otherwise Google sign-in is off (source "none").
//
// The row's value holds everything but the client secret, which is sealed
// with QATLAS_MASTER_KEY in secret_enc (internal/secrets) and never returned,
// logged or audited. Every process caches the active configuration and drops
// the cache on NOTIFY qatlas_settings 'google_auth' (storage.Registry.OnNotify
// → Service.ReloadGoogleSettings); the process that saves drops it at once.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// SettingsChannel is the NOTIFY channel announcing settings changes (shared
// with internal/storage, whose Registry runs the LISTEN connection).
const SettingsChannel = "qatlas_settings"

// GooglePayload is the NOTIFY payload on SettingsChannel after a Google
// sign-in settings change; also the system_settings key.
const GooglePayload = "google_auth"

// Sources of the active Google configuration (GoogleAuthSettings.source).
const (
	GoogleSourceNone     = "none"
	GoogleSourceDatabase = "database"
	GoogleSourceEnv      = "env"
)

// Audit actions of the Google sign-in settings.
const (
	ActionGoogleSettingsUpdate = "settings.google_auth.update"
	ActionGoogleSettingsDelete = "settings.google_auth.delete"
)

// CodeEnvOverride is the 409 error code of writes while GOOGLE_CLIENT_ID is set.
const CodeEnvOverride = "env_override"

const (
	googleSettingsKey    = GooglePayload
	maxClientJSONBytes   = 64 << 10
	maxGoogleListEntries = 100
	maxAllowedDomains    = 100
)

// googleValue is system_settings.value of key "google_auth" (no secret).
type googleValue struct {
	Enabled           bool     `json:"enabled"`
	ClientID          string   `json:"client_id"`
	ProjectID         string   `json:"project_id"`
	RedirectURIs      []string `json:"redirect_uris"`
	JavascriptOrigins []string `json:"javascript_origins"`
	AllowedDomains    []string `json:"allowed_domains"`
}

// googleRow is the "google_auth" row.
type googleRow struct {
	Value          googleValue
	SecretEnc      []byte
	UpdatedAt      time.Time
	UpdatedBy      *uuid.UUID
	UpdatedByName  *string
	UpdatedByEmail *string
}

func loadGoogleRow(ctx context.Context, q db.Querier, forUpdate bool) (*googleRow, error) {
	sql := `
		SELECT s.value, s.secret_enc, s.updated_at, s.updated_by, u.name, u.email
		FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by
		WHERE s.key = $1`
	if forUpdate {
		sql += ` FOR UPDATE OF s`
	}
	var (
		row googleRow
		raw []byte
	)
	err := q.QueryRow(ctx, sql, googleSettingsKey).Scan(&raw, &row.SecretEnc, &row.UpdatedAt, &row.UpdatedBy, &row.UpdatedByName, &row.UpdatedByEmail)
	if db.IsNoRows(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &row.Value); err != nil {
		return nil, fmt.Errorf("google sign-in settings: %w", err)
	}
	return &row, nil
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

// openSecret decrypts the stored client secret.
func (row *googleRow) openSecret(masterKey []byte) (string, error) {
	if len(row.SecretEnc) == 0 {
		return "", errors.New("no client secret is stored")
	}
	if len(masterKey) == 0 {
		return "", errors.New("QATLAS_MASTER_KEY is not set, so the stored client secret cannot be decrypted")
	}
	pt, err := secrets.Open(masterKey, row.SecretEnc)
	if err != nil {
		return "", errors.New("the stored client secret cannot be decrypted (was QATLAS_MASTER_KEY changed?)")
	}
	return string(pt), nil
}

// ------------------------------------------------------------------ active configuration

// googleClient is one immutable snapshot of the active configuration.
type googleClient struct {
	source         string
	enabled        bool // sign-in usable: switched on and complete credentials
	clientID       string
	clientSecret   string
	allowedDomains []string
	problem        string // why stored settings cannot be used (shown as warning)
}

var googleNone = &googleClient{source: GoogleSourceNone}

// googleSettings resolves and caches the active configuration.
type googleSettings struct {
	pool      *pgxpool.Pool
	masterKey []byte
	env       *googleClient // non-nil: GOOGLE_CLIENT_ID is set (environment override)

	mu  sync.Mutex // held while loading, so invalidate never races a load
	cur *googleClient
}

func newGoogleSettings(pool *pgxpool.Pool, cfg *config.Config) *googleSettings {
	g := &googleSettings{pool: pool, masterKey: cfg.MasterKey}
	if cfg.GoogleClientID != "" {
		g.env = &googleClient{
			source:         GoogleSourceEnv,
			enabled:        cfg.GoogleClientSecret != "",
			clientID:       cfg.GoogleClientID,
			clientSecret:   cfg.GoogleClientSecret,
			allowedDomains: slices.Clone(cfg.GoogleAllowedDomains),
		}
	}
	return g
}

// active returns the configuration in effect (cached until invalidate).
func (g *googleSettings) active(ctx context.Context) (*googleClient, error) {
	if g.env != nil {
		return g.env, nil
	}
	if g.pool == nil {
		return googleNone, nil
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.cur != nil {
		return g.cur, nil
	}
	row, err := loadGoogleRow(ctx, g.pool, false)
	if isUndefinedTable(err) {
		return googleNone, nil // migrations pending: not cached
	}
	if err != nil {
		return nil, err
	}
	g.cur = g.fromRow(row)
	return g.cur, nil
}

// invalidate drops the cache: the next request reloads from the database.
func (g *googleSettings) invalidate() {
	g.mu.Lock()
	g.cur = nil
	g.mu.Unlock()
}

func (g *googleSettings) fromRow(row *googleRow) *googleClient {
	if row == nil {
		return googleNone
	}
	c := &googleClient{
		source:         GoogleSourceDatabase,
		clientID:       row.Value.ClientID,
		allowedDomains: slices.Clone(row.Value.AllowedDomains),
	}
	secret, err := row.openSecret(g.masterKey)
	if err != nil {
		c.problem = "Google sign-in cannot be used: " + err.Error() + ". Upload the OAuth client JSON again."
	}
	c.clientSecret = secret
	c.enabled = row.Value.Enabled && c.clientID != "" && c.clientSecret != ""
	if !row.Value.Enabled {
		c.problem = "" // switched off: nothing to warn about
	}
	return c
}

// ReloadGoogleSettings drops the cached Google sign-in configuration (called
// on NOTIFY qatlas_settings 'google_auth' and after a listener reconnect).
func (s *Service) ReloadGoogleSettings() { s.googleCfg.invalidate() }

// ------------------------------------------------------------------ DTOs

// GoogleAuthSettings is the OpenAPI GoogleAuthSettings (never the secret).
type GoogleAuthSettings struct {
	Enabled               bool       `json:"enabled"`
	Source                string     `json:"source"`
	EnvOverride           bool       `json:"env_override"`
	ClientID              *string    `json:"client_id"`
	ClientSecretSet       bool       `json:"client_secret_set"`
	ProjectID             *string    `json:"project_id"`
	RedirectURI           string     `json:"redirect_uri"`
	JavascriptOrigin      string     `json:"javascript_origin"`
	RedirectURIRegistered *bool      `json:"redirect_uri_registered"`
	AllowedDomains        []string   `json:"allowed_domains"`
	UpdatedAt             *time.Time `json:"updated_at"`
	UpdatedBy             *UserRef   `json:"updated_by"`
	Warning               *string    `json:"warning"`
}

// GoogleAuthSettingsInput is the OpenAPI GoogleAuthSettingsInput. A nil
// ClientJSON (or blank) keeps the stored credentials; nil AllowedDomains keeps
// the stored list.
type GoogleAuthSettingsInput struct {
	Enabled        *bool    `json:"enabled"`
	ClientJSON     *string  `json:"client_json"`
	AllowedDomains []string `json:"allowed_domains"`
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// googleSettingsDTO renders the settings from the database (fresh, not the
// cache) or the environment.
func (s *Service) googleSettingsDTO(ctx context.Context) (GoogleAuthSettings, error) {
	redirect := s.googleRedirectURL()
	out := GoogleAuthSettings{
		Source:           GoogleSourceNone,
		RedirectURI:      redirect,
		JavascriptOrigin: s.cfg.BaseURL,
		AllowedDomains:   []string{},
	}
	row, err := loadGoogleRow(ctx, s.pool, false)
	if err != nil && !isUndefinedTable(err) {
		return out, err
	}
	var warnings []string
	if env := s.googleCfg.env; env != nil {
		out.Source, out.EnvOverride, out.Enabled = GoogleSourceEnv, true, env.enabled
		out.ClientID = nonEmpty(env.clientID)
		out.ClientSecretSet = env.clientSecret != ""
		out.AllowedDomains = append(out.AllowedDomains, env.allowedDomains...)
		if row != nil {
			warnings = append(warnings, "Settings saved in Admin → Google sign-in are ignored while GOOGLE_CLIENT_ID is set in the server environment.")
		}
	} else if row != nil {
		c := s.googleCfg.fromRow(row)
		v := row.Value
		out.Source, out.Enabled = GoogleSourceDatabase, c.enabled
		out.ClientID, out.ProjectID = nonEmpty(v.ClientID), nonEmpty(v.ProjectID)
		out.ClientSecretSet = len(row.SecretEnc) > 0
		out.AllowedDomains = append(out.AllowedDomains, v.AllowedDomains...)
		registered := slices.Contains(v.RedirectURIs, redirect)
		out.RedirectURIRegistered = &registered
		out.UpdatedAt = UTCPtr(&row.UpdatedAt)
		if row.UpdatedBy != nil {
			ref := NewUserRef(row.UpdatedBy, row.UpdatedByName, row.UpdatedByEmail)
			out.UpdatedBy = &ref
		}
		if c.problem != "" {
			warnings = append(warnings, c.problem)
		}
		if !registered {
			warnings = append(warnings, "The uploaded OAuth client does not list "+redirect+
				" as an authorized redirect URI, so Google will refuse the sign-in. Add it in Google Cloud Console "+
				"(APIs & Services → Credentials → your OAuth client), then upload the downloaded JSON again.")
		}
	}
	if w := baseURLWarning(s.cfg.BaseURL); w != "" {
		warnings = append(warnings, w)
	}
	if len(warnings) > 0 {
		w := strings.Join(warnings, " ")
		out.Warning = &w
	}
	return out, nil
}

// baseURLWarning explains a QATLAS_BASE_URL Google cannot redirect to.
func baseURLWarning(base string) string {
	if base == "" {
		return "QATLAS_BASE_URL is not set, so the redirect URI is unknown: set it to the URL users open (e.g. https://qatlas.example.com) and restart."
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return "QATLAS_BASE_URL is not an absolute URL: set it to the URL users open (e.g. https://qatlas.example.com) and restart."
	}
	if base == config.DefaultBaseURL {
		return "QATLAS_BASE_URL is not set (default " + config.DefaultBaseURL + "): if users open QAtlas under another URL, set QATLAS_BASE_URL to it and restart, the redirect URI is derived from it."
	}
	if u.Scheme != "https" && !isLoopbackHost(u.Hostname()) {
		return "Google accepts http redirect URIs only for localhost: serve QAtlas over https and set QATLAS_BASE_URL to the https URL (e.g. https://qatlas.example.com), then restart."
	}
	return ""
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// ------------------------------------------------------------------ validation

// googleClientFile is the validated "web" section of Google's client JSON.
type googleClientFile struct {
	ClientID          string
	ClientSecret      string
	ProjectID         string
	RedirectURIs      []string
	JavascriptOrigins []string
}

var (
	googleClientIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.apps\.googleusercontent\.com$`)
	domainLabelRe    = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
)

// parseGoogleClientJSON validates the OAuth client JSON downloaded from Google
// Cloud Console; every problem is a detail with path "client_json".
func parseGoogleClientJSON(raw string) (*googleClientFile, []httpx.FieldError) {
	bad := func(msg string) (*googleClientFile, []httpx.FieldError) {
		return nil, []httpx.FieldError{httpx.Field("client_json", msg)}
	}
	if len(raw) > maxClientJSONBytes {
		return bad("The file is too large for an OAuth client JSON (at most 64 KiB).")
	}
	if !json.Valid([]byte(raw)) {
		return bad("Not valid JSON. Upload the client_secret_….json file downloaded from Google Cloud Console (APIs & Services → Credentials).")
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &top); err != nil || top == nil {
		return bad(`Not a Google OAuth client JSON: expected an object with a "web" section.`)
	}
	web, ok := top["web"]
	if !ok {
		if _, installed := top["installed"]; installed {
			return bad(`This is a Desktop app ("installed") OAuth client. QAtlas needs a Web application client: ` +
				`in Google Cloud Console create an OAuth client ID of type "Web application", add the redirect URI shown here and upload its JSON.`)
		}
		return bad(`Not a Google OAuth client JSON: the "web" section is missing (the client must be of type "Web application").`)
	}
	var sec struct {
		ClientID          string   `json:"client_id"`
		ClientSecret      string   `json:"client_secret"`
		ProjectID         string   `json:"project_id"`
		RedirectURIs      []string `json:"redirect_uris"`
		JavascriptOrigins []string `json:"javascript_origins"`
	}
	if err := json.Unmarshal(web, &sec); err != nil {
		return bad(`The "web" section is malformed: client_id, client_secret and project_id must be strings, redirect_uris and javascript_origins lists of strings.`)
	}
	var details []httpx.FieldError
	add := func(msg string) { details = append(details, httpx.Field("client_json", msg)) }
	out := &googleClientFile{
		ClientID:     strings.TrimSpace(sec.ClientID),
		ClientSecret: strings.TrimSpace(sec.ClientSecret),
		ProjectID:    strings.TrimSpace(sec.ProjectID),
	}
	switch {
	case out.ClientID == "":
		add("client_id is missing.")
	case !googleClientIDRe.MatchString(out.ClientID):
		add("client_id must be a Google OAuth client ID ending with .apps.googleusercontent.com.")
	}
	switch {
	case out.ClientSecret == "":
		add("client_secret is missing. Google includes it only in the JSON downloaded when the client (or a new secret) is created: add a secret and download the JSON again.")
	case len(out.ClientSecret) > 256 || strings.ContainsFunc(out.ClientSecret, func(r rune) bool { return r <= ' ' || r >= 0x7f }):
		add("client_secret is malformed (at most 256 printable characters without spaces).")
	}
	if len(out.ProjectID) > 255 {
		add("project_id is too long.")
	}
	var listErr bool
	out.RedirectURIs, listErr = cleanList(sec.RedirectURIs)
	if listErr {
		add(fmt.Sprintf("redirect_uris: at most %d entries of at most 2048 characters.", maxGoogleListEntries))
	}
	out.JavascriptOrigins, listErr = cleanList(sec.JavascriptOrigins)
	if listErr {
		add(fmt.Sprintf("javascript_origins: at most %d entries of at most 2048 characters.", maxGoogleListEntries))
	}
	if len(details) > 0 {
		return nil, details
	}
	return out, nil
}

// cleanList trims, drops blanks and duplicates; tooLong when out of bounds.
func cleanList(in []string) (out []string, tooLong bool) {
	out = []string{}
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" || slices.Contains(out, v) {
			continue
		}
		if len(v) > 2048 {
			tooLong = true
		}
		out = append(out, v)
	}
	return out, tooLong || len(out) > maxGoogleListEntries
}

// normalizeDomains lowercases, strips "@" and a trailing dot, drops blanks and
// duplicates and validates host names (details "allowed_domains[i]").
func normalizeDomains(in []string) ([]string, []httpx.FieldError) {
	out := []string{}
	var details []httpx.FieldError
	if len(in) > maxAllowedDomains {
		return nil, []httpx.FieldError{httpx.Field("allowed_domains", fmt.Sprintf("At most %d domains", maxAllowedDomains))}
	}
	for i, d := range in {
		d = strings.TrimSuffix(strings.TrimPrefix(strings.ToLower(strings.TrimSpace(d)), "@"), ".")
		if d == "" {
			continue
		}
		if !validDomain(d) {
			details = append(details, httpx.Field(fmt.Sprintf("allowed_domains[%d]", i), "Not a valid email domain (e.g. example.com)"))
			continue
		}
		if !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	return out, details
}

func validDomain(d string) bool {
	if len(d) > 253 {
		return false
	}
	labels := strings.Split(d, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if !domainLabelRe.MatchString(l) {
			return false
		}
	}
	tld := labels[len(labels)-1]
	return strings.ContainsFunc(tld, func(r rune) bool { return r < '0' || r > '9' }) // not an IP address
}

// googleChanged lists the fields an update changes (audit; never values of secrets).
func googleChanged(old *googleValue, next googleValue, secretChanged bool) []string {
	var a googleValue
	if old != nil {
		a = *old
	}
	out := []string{}
	for _, f := range []struct {
		name string
		diff bool
	}{
		{"enabled", a.Enabled != next.Enabled},
		{"client_id", a.ClientID != next.ClientID},
		{"client_secret", secretChanged},
		{"project_id", a.ProjectID != next.ProjectID},
		{"redirect_uris", !slices.Equal(a.RedirectURIs, next.RedirectURIs)},
		{"javascript_origins", !slices.Equal(a.JavascriptOrigins, next.JavascriptOrigins)},
		{"allowed_domains", !slices.Equal(a.AllowedDomains, next.AllowedDomains)},
	} {
		if f.diff {
			out = append(out, f.name)
		}
	}
	return out
}

// ------------------------------------------------------------------ service

func requireAdminActor(actor *Actor) error {
	if !actor.IsAdmin() {
		return httpx.Forbidden("Only admins can do this")
	}
	return nil
}

func (s *Service) googleEnvOverride() error {
	if s.googleCfg.env == nil {
		return nil
	}
	return httpx.NewError(http.StatusConflict, CodeEnvOverride,
		"Google sign-in is configured by the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET environment variables on this server. "+
			"Remove them (and GOOGLE_ALLOWED_DOMAINS) from the server environment and restart it to manage Google sign-in here.")
}

// GetGoogleSettings returns the Google sign-in settings (admin only).
func (s *Service) GetGoogleSettings(ctx context.Context, actor *Actor) (GoogleAuthSettings, error) {
	if err := requireAdminActor(actor); err != nil {
		return GoogleAuthSettings{}, err
	}
	return s.googleSettingsDTO(ctx)
}

// UpdateGoogleSettings validates and saves the settings (secret sealed), then
// applies them here and notifies the other processes.
func (s *Service) UpdateGoogleSettings(ctx context.Context, actor *Actor, in GoogleAuthSettingsInput) (GoogleAuthSettings, error) {
	if err := requireAdminActor(actor); err != nil {
		return GoogleAuthSettings{}, err
	}
	if err := s.googleEnvOverride(); err != nil {
		return GoogleAuthSettings{}, err
	}
	var details []httpx.FieldError
	if in.Enabled == nil {
		details = append(details, httpx.Field("enabled", "Required"))
	}
	var file *googleClientFile
	if in.ClientJSON != nil && strings.TrimSpace(*in.ClientJSON) != "" {
		var d []httpx.FieldError
		file, d = parseGoogleClientJSON(*in.ClientJSON)
		details = append(details, d...)
	}
	var domains []string
	if in.AllowedDomains != nil {
		var d []httpx.FieldError
		domains, d = normalizeDomains(in.AllowedDomains)
		details = append(details, d...)
	}
	if len(details) > 0 {
		return GoogleAuthSettings{}, httpx.Unprocessable("Invalid Google sign-in settings", details...)
	}
	masterKey := s.cfg.MasterKey
	if file != nil && len(masterKey) != secrets.KeySize {
		return GoogleAuthSettings{}, httpx.Unprocessable("QATLAS_MASTER_KEY is required to store the client secret",
			httpx.Field("client_json", "QATLAS_MASTER_KEY is not set on this server, so the client secret cannot be stored encrypted."))
	}

	var next googleValue
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		row, err := loadGoogleRow(ctx, tx, true)
		if err != nil {
			return err
		}
		var (
			old       *googleValue
			secretEnc []byte
			oldSecret string
			oldErr    = errors.New("no client secret is stored")
		)
		if row != nil {
			v := row.Value
			old, next, secretEnc = &v, v, row.SecretEnc
			oldSecret, oldErr = row.openSecret(masterKey)
		}
		secretChanged := false
		switch {
		case file != nil:
			next.ClientID, next.ProjectID = file.ClientID, file.ProjectID
			next.RedirectURIs, next.JavascriptOrigins = file.RedirectURIs, file.JavascriptOrigins
			secretChanged = oldErr != nil || oldSecret != file.ClientSecret
			if secretChanged {
				if secretEnc, err = secrets.Seal(masterKey, []byte(file.ClientSecret)); err != nil {
					return err
				}
			}
		case row == nil || row.Value.ClientID == "" || len(row.SecretEnc) == 0:
			return httpx.Unprocessable("Upload the OAuth client JSON",
				httpx.Field("client_json", "Upload the OAuth client JSON downloaded from Google Cloud Console (required the first time)."))
		case *in.Enabled && oldErr != nil:
			return httpx.Unprocessable("The stored client secret cannot be used",
				httpx.Field("client_json", "The stored client secret cannot be used ("+oldErr.Error()+"); upload the OAuth client JSON again."))
		}
		if in.AllowedDomains != nil {
			next.AllowedDomains = domains
		}
		if next.AllowedDomains == nil {
			next.AllowedDomains = []string{}
		}
		if next.RedirectURIs == nil {
			next.RedirectURIs = []string{}
		}
		if next.JavascriptOrigins == nil {
			next.JavascriptOrigins = []string{}
		}
		next.Enabled = *in.Enabled
		value, err := json.Marshal(next)
		if err != nil {
			return err
		}
		uid := actor.User.ID
		if _, err := tx.Exec(ctx, `
			-- secret_updated_at only moves when the secret changes
			INSERT INTO system_settings AS s (key, value, secret_enc, secret_updated_at, updated_at, updated_by)
			VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp(), $4)
			ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret_enc = EXCLUDED.secret_enc,
				secret_updated_at = CASE WHEN $5 THEN EXCLUDED.secret_updated_at ELSE s.secret_updated_at END,
				updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
			googleSettingsKey, value, secretEnc, uid, secretChanged); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, ActionGoogleSettingsUpdate, "settings", googleSettingsKey, nil, audit.Meta{
			"client_id":            next.ClientID,
			"enabled":              next.Enabled,
			"changed":              googleChanged(old, next, secretChanged),
			"client_json_uploaded": file != nil,
		}); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, SettingsChannel, GooglePayload)
		return err
	})
	if err != nil {
		return GoogleAuthSettings{}, err
	}
	s.googleCfg.invalidate()
	s.log.InfoContext(ctx, "google sign-in settings saved", "client_id", next.ClientID, "enabled", next.Enabled)
	return s.googleSettingsDTO(ctx)
}

// DeleteGoogleSettings removes the stored settings (Google sign-in is off
// unless configured by the environment) and returns the resulting settings.
func (s *Service) DeleteGoogleSettings(ctx context.Context, actor *Actor) (GoogleAuthSettings, error) {
	if err := requireAdminActor(actor); err != nil {
		return GoogleAuthSettings{}, err
	}
	if err := s.googleEnvOverride(); err != nil {
		return GoogleAuthSettings{}, err
	}
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var clientID *string
		err := tx.QueryRow(ctx, `DELETE FROM system_settings WHERE key = $1 RETURNING value->>'client_id'`, googleSettingsKey).Scan(&clientID)
		if db.IsNoRows(err) {
			return nil // nothing stored: nothing to audit
		}
		if err != nil {
			return err
		}
		id := ""
		if clientID != nil {
			id = *clientID
		}
		if err := audit.Record(ctx, tx, actor, ActionGoogleSettingsDelete, "settings", googleSettingsKey, nil, audit.Meta{"client_id": id}); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, SettingsChannel, GooglePayload)
		return err
	})
	if err != nil {
		return GoogleAuthSettings{}, err
	}
	s.googleCfg.invalidate()
	return s.googleSettingsDTO(ctx)
}

// ------------------------------------------------------------------ handlers

// SettingsRoutes mounts /admin/settings/google-auth (inside the authenticated
// group; admin, browser session only).
func (s *Service) SettingsRoutes(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(RequireSession)
		r.Get("/admin/settings/google-auth", httpx.Handle(s.handleGetGoogleSettings))
		r.Put("/admin/settings/google-auth", httpx.Handle(s.handlePutGoogleSettings))
		r.Delete("/admin/settings/google-auth", httpx.Handle(s.handleDeleteGoogleSettings))
	})
}

func (s *Service) handleGetGoogleSettings(w http.ResponseWriter, r *http.Request) error {
	actor, err := MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.GetGoogleSettings(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handlePutGoogleSettings(w http.ResponseWriter, r *http.Request) error {
	actor, err := MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := requireAdminActor(actor); err != nil {
		return err
	}
	var in GoogleAuthSettingsInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.UpdateGoogleSettings(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleDeleteGoogleSettings(w http.ResponseWriter, r *http.Request) error {
	actor, err := MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.DeleteGoogleSettings(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}
