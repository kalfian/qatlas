package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

const googlePath = "/api/v1/admin/settings/google-auth"

// Fake values shaped like Google's (nothing here talks to Google).
const (
	fakeClientID     = "qatlas-test-client.apps.googleusercontent.com"
	fakeClientSecret = "qatlas-test-client-secret"
)

var testRedirectURI = testBaseURL + "/api/v1/auth/google/callback"

// googleClientJSON is a "Web application" client JSON as downloaded from
// Google Cloud Console.
func googleClientJSON(clientID, secret string, redirectURIs ...string) string {
	web := map[string]any{
		"client_id": clientID, "project_id": "qatlas-test", "auth_uri": "https://accounts.google.com/o/oauth2/auth",
		"token_uri": "https://oauth2.googleapis.com/token", "client_secret": secret,
		"redirect_uris": redirectURIs, "javascript_origins": []string{testBaseURL},
	}
	b, _ := json.Marshal(map[string]any{"web": web})
	return string(b)
}

func (c *client) googleSettings() auth.GoogleAuthSettings {
	c.env.t.Helper()
	var st auth.GoogleAuthSettings
	c.expect("GET", googlePath, nil, 200, &st)
	return st
}

func (c *client) googleEnabled() bool {
	c.env.t.Helper()
	var cfg auth.AuthConfig
	c.expect("GET", "/api/v1/auth/config", nil, 200, &cfg)
	return cfg.GoogleEnabled
}

// detailPaths returns the error code and the detail paths of an error response.
func detailPaths(t *testing.T, r response) (string, []string) {
	t.Helper()
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Details []struct{ Path, Message string }
		} `json:"error"`
	}
	r.decode(t, &body)
	var paths []string
	for _, d := range body.Error.Details {
		paths = append(paths, d.Path)
	}
	return body.Error.Code, paths
}

// Admin → Google sign-in: validation, encrypted write-only secret, immediate
// effect on /auth/config and /auth/google/start here and (NOTIFY) in another
// server process, keeping credentials, allowed domains, delete, permissions.
func TestGoogleSettings(t *testing.T) {
	e := newEnv(t)
	adminID := e.createUser("root@example.com", "Root", "admin", "active", testPassword)
	memberID := e.createUser("max@other.com", "Max", "member", "active", testPassword)
	admin := e.browser()
	admin.login("root@example.com", testPassword)
	other := e.sibling() // a second server process on the same database
	anon, anonOther := e.browser(), other.browser()

	// ---- default: none, disabled; every required key is rendered.
	raw := admin.expect("GET", googlePath, nil, 200, nil)
	var keys map[string]json.RawMessage
	raw.decode(t, &keys)
	for _, k := range []string{"enabled", "source", "env_override", "client_id", "client_secret_set", "project_id", "redirect_uri",
		"javascript_origin", "redirect_uri_registered", "allowed_domains", "updated_at", "updated_by", "warning"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("GET lacks %q: %s", k, raw.body)
		}
	}
	st := admin.googleSettings()
	if st.Enabled || st.Source != "none" || st.EnvOverride || st.ClientID != nil || st.ClientSecretSet || st.ProjectID != nil ||
		st.RedirectURI != testRedirectURI || st.JavascriptOrigin != testBaseURL || st.RedirectURIRegistered != nil ||
		st.AllowedDomains == nil || len(st.AllowedDomains) != 0 || st.UpdatedAt != nil || st.UpdatedBy != nil {
		t.Fatalf("default settings: %s", raw.body)
	}
	// http and not localhost: Google would refuse the redirect URI.
	if st.Warning == nil || !strings.Contains(*st.Warning, "https") {
		t.Fatalf("base URL warning: %s", raw.body)
	}
	if anon.googleEnabled() || anonOther.googleEnabled() { // also primes the other process's cache
		t.Fatal("google enabled by default")
	}

	// ---- permissions: members 403, API tokens 403 (session only), CSRF.
	member := e.browser()
	member.login("max@other.com", testPassword)
	good := map[string]any{"enabled": true, "client_json": googleClientJSON(fakeClientID, fakeClientSecret, testRedirectURI),
		"allowed_domains": []string{" @Corp.IO ", "example.com", "corp.io", ""}}
	member.expect("GET", googlePath, nil, 403, nil)
	member.expect("PUT", googlePath, good, 403, nil)
	member.expect("DELETE", googlePath, nil, 403, nil)
	var tok auth.CreatedToken
	admin.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ci", "scopes": []string{"read", "write"}}, 201, &tok)
	e.bearer(tok.Secret).expect("GET", googlePath, nil, 403, nil)
	e.bearer(tok.Secret).expect("PUT", googlePath, good, 403, nil)
	e.bearer(tok.Secret).expect("DELETE", googlePath, nil, 403, nil)
	noCSRF := *admin
	noCSRF.noCSRF = true
	noCSRF.expect("PUT", googlePath, good, 403, nil)

	// ---- validation: 422 validation_failed, nothing saved.
	saved := func() int { return e.count(`SELECT count(*) FROM system_settings WHERE key = 'google_auth'`) }
	for name, tc := range map[string]struct {
		body  map[string]any
		paths []string
		text  string
	}{
		"invalid json":   {map[string]any{"enabled": true, "client_json": `{"web": {`}, []string{"client_json"}, "Not valid JSON"},
		"installed":      {map[string]any{"enabled": true, "client_json": `{"installed": {"client_id": "` + fakeClientID + `", "client_secret": "x"}}`}, []string{"client_json"}, "Web application"},
		"no web section": {map[string]any{"enabled": true, "client_json": `{"client_id": "` + fakeClientID + `"}`}, []string{"client_json"}, "section is missing"},
		"not an object":  {map[string]any{"enabled": true, "client_json": `["web"]`}, []string{"client_json"}, "Not a Google OAuth client JSON"},
		"missing secret": {map[string]any{"enabled": true, "client_json": googleClientJSON(fakeClientID, "", testRedirectURI)}, []string{"client_json"}, "client_secret is missing"},
		"bad client id":  {map[string]any{"enabled": true, "client_json": googleClientJSON("123.example.com", fakeClientSecret)}, []string{"client_json"}, ".apps.googleusercontent.com"},
		"first save":     {map[string]any{"enabled": false}, []string{"client_json"}, "required the first time"},
		"enabled absent": {map[string]any{"client_json": googleClientJSON(fakeClientID, fakeClientSecret)}, []string{"enabled"}, "Required"},
		"bad domain": {map[string]any{"enabled": true, "client_json": googleClientJSON(fakeClientID, fakeClientSecret),
			"allowed_domains": []string{"corp.io", "not a domain", "user@corp.io", "10.0.0.1"}},
			[]string{"allowed_domains[1]", "allowed_domains[2]", "allowed_domains[3]"}, "valid email domain"},
	} {
		r := admin.expect("PUT", googlePath, tc.body, 422, nil)
		code, paths := detailPaths(t, r)
		if code != "validation_failed" || !slices.Equal(paths, tc.paths) || !strings.Contains(string(r.body), tc.text) {
			t.Fatalf("%s: %s", name, r.body)
		}
	}
	if saved() != 0 || e.count(`SELECT count(*) FROM audit_logs WHERE action LIKE 'settings.google_auth.%'`) != 0 || anon.googleEnabled() {
		t.Fatal("failed PUTs saved something")
	}

	// ---- PUT good: active at once here, and in the other process via NOTIFY.
	raw = admin.expect("PUT", googlePath, good, 200, &st)
	if !st.Enabled || st.Source != "database" || st.EnvOverride || st.ClientID == nil || *st.ClientID != fakeClientID ||
		!st.ClientSecretSet || st.ProjectID == nil || *st.ProjectID != "qatlas-test" || st.RedirectURIRegistered == nil ||
		!*st.RedirectURIRegistered || !slices.Equal(st.AllowedDomains, []string{"corp.io", "example.com"}) || st.UpdatedAt == nil ||
		st.UpdatedBy == nil || st.UpdatedBy.ID != adminID.String() {
		t.Fatalf("after PUT: %s", raw.body)
	}
	if st.Warning == nil || strings.Contains(*st.Warning, "does not list") {
		t.Fatalf("warning after PUT (only the base URL one expected): %v", deref(st.Warning))
	}
	if !anon.googleEnabled() {
		t.Fatal("google_enabled must be true right after the PUT")
	}
	waitFor(t, 10*time.Second, "the other server to enable Google sign-in", anonOther.googleEnabled)

	// The secret is in no response, no audit row and not in plaintext in the database.
	for _, body := range [][]byte{raw.body, admin.expect("GET", googlePath, nil, 200, nil).body} {
		if bytes.Contains(body, []byte(fakeClientSecret)) || bytes.Contains(body, []byte("client_secret\"")) {
			t.Fatalf("secret in response: %s", body)
		}
	}
	auditMeta := func(action string) (raw []byte, meta struct {
		ClientID string   `json:"client_id"`
		Changed  []string `json:"changed"`
		Uploaded bool     `json:"client_json_uploaded"`
	}) {
		t.Helper()
		if err := e.pool.QueryRow(e.ctx, `SELECT meta FROM audit_logs WHERE action = $1 AND actor_user_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
			action, adminID).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		_ = json.Unmarshal(raw, &meta)
		if bytes.Contains(raw, []byte(fakeClientSecret)) {
			t.Fatalf("secret in audit meta: %s", raw)
		}
		return raw, meta
	}
	metaRaw, meta := auditMeta(auth.ActionGoogleSettingsUpdate)
	if meta.ClientID != fakeClientID || !meta.Uploaded ||
		!slices.Equal(meta.Changed, []string{"enabled", "client_id", "client_secret", "project_id", "redirect_uris", "javascript_origins", "allowed_domains"}) {
		t.Fatalf("audit meta: %s", metaRaw)
	}
	var enc, value []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT secret_enc, value FROM system_settings WHERE key = 'google_auth'`).Scan(&enc, &value); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte(fakeClientSecret)) || bytes.Contains(value, []byte(fakeClientSecret)) {
		t.Fatal("secret stored in plaintext")
	}
	if pt, err := secrets.Open(testMasterKey, enc); err != nil || string(pt) != fakeClientSecret {
		t.Fatalf("sealed secret: %v", err)
	}

	// ---- /auth/google/start: redirect to Google with the stored client and the computed redirect URI.
	checkStart := func(c *client, clientID string) {
		t.Helper()
		r := c.atBase().do("GET", "/api/v1/auth/google/start", nil)
		loc, err := url.Parse(r.header.Get("Location"))
		if r.status != http.StatusFound || err != nil {
			t.Fatalf("start: %d %s", r.status, r.header.Get("Location"))
		}
		q := loc.Query()
		if loc.Scheme != "https" || loc.Host != "accounts.google.com" || loc.Path != "/o/oauth2/v2/auth" ||
			q.Get("client_id") != clientID || q.Get("redirect_uri") != testRedirectURI || q.Get("response_type") != "code" ||
			q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" || q.Get("state") == "" || q.Get("nonce") == "" ||
			!strings.Contains(q.Get("scope"), "openid") || strings.Contains(loc.RawQuery, fakeClientSecret) {
			t.Fatalf("start redirect: %s", loc)
		}
		if !strings.Contains(r.header.Get("Set-Cookie"), "qatlas_oidc=") {
			t.Fatalf("no state cookie: %v", r.header)
		}
	}
	checkStart(e.browser(), fakeClientID)
	checkStart(other.browser(), fakeClientID)

	// ---- PUT without client_json keeps the credentials and updates the domains.
	admin.expect("PUT", googlePath, map[string]any{"enabled": true, "allowed_domains": []string{"Other.COM."}}, 200, &st)
	if !st.Enabled || st.ClientID == nil || *st.ClientID != fakeClientID || !st.ClientSecretSet || !slices.Equal(st.AllowedDomains, []string{"other.com"}) {
		t.Fatalf("keep credentials: %+v", st)
	}
	var enc2 []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT secret_enc FROM system_settings WHERE key = 'google_auth'`).Scan(&enc2); err != nil || !bytes.Equal(enc, enc2) {
		t.Fatalf("secret must be kept unchanged: %v", err)
	}
	if metaRaw, meta = auditMeta(auth.ActionGoogleSettingsUpdate); meta.Uploaded || !slices.Equal(meta.Changed, []string{"allowed_domains"}) {
		t.Fatalf("audit meta (domains only): %s", metaRaw)
	}
	// Omitting allowed_domains keeps them too; the domain list is enforced on sign-in.
	admin.expect("PUT", googlePath, map[string]any{"enabled": true}, 200, &st)
	if !slices.Equal(st.AllowedDomains, []string{"other.com"}) {
		t.Fatalf("domains kept: %+v", st.AllowedDomains)
	}
	completeLogin := func(email string) string {
		return e.srv.Auth.CompleteGoogleLogin(e.ctx, httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil),
			auth.GoogleIdentity{Subject: "sub-" + email, Email: email, EmailVerified: true})
	}
	e.createUser("ann@corp.io", "Ann", "member", "active", "")
	if to := completeLogin("ann@corp.io"); to != "/login?error=domain_not_allowed" {
		t.Fatalf("domain filter: %s", to)
	}
	if to := completeLogin("max@other.com"); to != "/" {
		t.Fatalf("allowed domain: %s", to)
	}
	if n := e.count(`SELECT count(*) FROM users WHERE id = $1 AND google_sub IS NOT NULL`, memberID); n != 1 {
		t.Fatal("google_sub not bound")
	}

	// ---- a client without our redirect URI: saved, flagged.
	admin.expect("PUT", googlePath, map[string]any{"enabled": true, "client_json": googleClientJSON(fakeClientID, fakeClientSecret, "https://elsewhere.example.com/cb")}, 200, &st)
	if st.RedirectURIRegistered == nil || *st.RedirectURIRegistered || st.Warning == nil || !strings.Contains(*st.Warning, "does not list "+testRedirectURI) {
		t.Fatalf("unregistered redirect URI: %+v %s", st, deref(st.Warning))
	}
	if _, meta = auditMeta(auth.ActionGoogleSettingsUpdate); !meta.Uploaded || !slices.Equal(meta.Changed, []string{"redirect_uris"}) {
		t.Fatalf("same secret re-uploaded must not count as changed: %+v", meta)
	}

	// ---- switched off: config false, start fails, credentials kept.
	admin.expect("PUT", googlePath, map[string]any{"enabled": false}, 200, &st)
	if st.Enabled || !st.ClientSecretSet || anon.googleEnabled() {
		t.Fatalf("disabled: %+v", st)
	}
	waitFor(t, 10*time.Second, "the other server to disable Google sign-in", func() bool { return !anonOther.googleEnabled() })
	if r := e.browser().atBase().do("GET", "/api/v1/auth/google/start", nil); r.status != http.StatusFound || r.header.Get("Location") != "/login?error=google_failed" {
		t.Fatalf("start while disabled: %d %s", r.status, r.header.Get("Location"))
	}
	admin.expect("PUT", googlePath, map[string]any{"enabled": true}, 200, &st)
	waitFor(t, 10*time.Second, "the other server to re-enable Google sign-in", anonOther.googleEnabled)

	// ---- DELETE: disabled, row gone, audited; idempotent.
	admin.expect("DELETE", googlePath, nil, 200, &st)
	if st.Enabled || st.Source != "none" || st.ClientID != nil || st.ClientSecretSet || len(st.AllowedDomains) != 0 || saved() != 0 || anon.googleEnabled() {
		t.Fatalf("after DELETE: %+v", st)
	}
	if _, meta = auditMeta(auth.ActionGoogleSettingsDelete); meta.ClientID != fakeClientID {
		t.Fatalf("delete audit: %+v", meta)
	}
	waitFor(t, 10*time.Second, "the other server to drop Google sign-in", func() bool { return !anonOther.googleEnabled() })
	admin.expect("DELETE", googlePath, nil, 200, &st)
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'settings.google_auth.delete'`); n != 1 {
		t.Fatalf("delete of nothing audited: %d", n)
	}
}

// GOOGLE_CLIENT_ID in the environment wins: read-only settings, 409 on writes.
func TestGoogleSettingsEnvOverride(t *testing.T) {
	pool := testutil.DB(t)
	cfg := &config.Config{HTTPAddr: ":0", BaseURL: "https://qatlas.example.com", DataDir: t.TempDir(), WorkerConcurrency: 1, MasterKey: testMasterKey,
		GoogleClientID: "envtest.apps.googleusercontent.com", GoogleClientSecret: "env-secret-value", GoogleAllowedDomains: []string{"corp.io"}}
	e := startEnv(t, pool, cfg)
	e.createUser("root@example.com", "Root", "admin", "active", testPassword)
	admin := e.browser()
	admin.login("root@example.com", testPassword)

	var st auth.GoogleAuthSettings
	raw := admin.expect("GET", googlePath, nil, 200, &st)
	if !st.Enabled || st.Source != "env" || !st.EnvOverride || st.ClientID == nil || *st.ClientID != cfg.GoogleClientID ||
		!st.ClientSecretSet || st.RedirectURIRegistered != nil || !slices.Equal(st.AllowedDomains, []string{"corp.io"}) ||
		st.RedirectURI != "https://qatlas.example.com/api/v1/auth/google/callback" || st.JavascriptOrigin != "https://qatlas.example.com" ||
		st.Warning != nil || bytes.Contains(raw.body, []byte("env-secret-value")) {
		t.Fatalf("env settings: %s", raw.body)
	}
	for _, method := range []string{"PUT", "DELETE"} {
		r := admin.expect(method, googlePath, map[string]any{"enabled": false, "client_json": googleClientJSON(fakeClientID, fakeClientSecret)}, 409, nil)
		if r.errCode(t) != auth.CodeEnvOverride || !strings.Contains(string(r.body), "GOOGLE_CLIENT_ID") {
			t.Fatalf("%s with env override: %s", method, r.body)
		}
	}
	if e.count(`SELECT count(*) FROM system_settings WHERE key = 'google_auth'`) != 0 {
		t.Fatal("saved despite the env override")
	}
	if !e.browser().googleEnabled() {
		t.Fatal("env google not enabled")
	}
	r := e.browser().atBase().do("GET", "/api/v1/auth/google/start", nil)
	loc, _ := url.Parse(r.header.Get("Location"))
	if r.status != http.StatusFound || loc == nil || loc.Host != "accounts.google.com" || loc.Query().Get("client_id") != cfg.GoogleClientID ||
		loc.Query().Get("redirect_uri") != "https://qatlas.example.com/api/v1/auth/google/callback" {
		t.Fatalf("env start: %d %s", r.status, r.header.Get("Location"))
	}
	// Started on another hostname of the same instance (LAN name next to the
	// public one): first moved to the base URL host, where the callback lands.
	lan := e.browser()
	lan.host = "qatlas.lan.example"
	r = lan.do("GET", "/api/v1/auth/google/start", nil)
	if r.status != http.StatusFound || r.header.Get("Location") != "https://qatlas.example.com/api/v1/auth/google/start" ||
		strings.Contains(r.header.Get("Set-Cookie"), "qatlas_oidc=") {
		t.Fatalf("start on another host: %d %s %v", r.status, r.header.Get("Location"), r.header)
	}
	// A row saved earlier (e.g. before the env vars were added) is ignored and flagged.
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO system_settings (key, value) VALUES ('google_auth', '{"enabled": true, "client_id": "db.apps.googleusercontent.com"}')`); err != nil {
		t.Fatal(err)
	}
	admin.expect("GET", googlePath, nil, 200, &st)
	if *st.ClientID != cfg.GoogleClientID || st.Warning == nil || !strings.Contains(*st.Warning, "ignored") {
		t.Fatalf("env with stored row: %+v", st)
	}
}
