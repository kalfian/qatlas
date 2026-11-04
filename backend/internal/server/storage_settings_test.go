package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/artifacts/s3test"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/secrets"
	"github.com/kalfian/qatlas/backend/internal/storage"
	"github.com/kalfian/qatlas/backend/internal/worker"
)

const storagePath = "/api/v1/admin/settings/storage"

// s3Input is a StorageSettingsInput.s3 body for cfg (secret "" = omitted).
func s3Input(cfg config.S3Config, secret string) map[string]any {
	in := map[string]any{
		"endpoint": cfg.Endpoint, "region": cfg.Region, "bucket": cfg.Bucket,
		"access_key_id": cfg.AccessKey, "prefix": cfg.Prefix, "force_path_style": cfg.ForcePathStyle,
	}
	if secret != "" {
		in["secret_access_key"] = secret
	}
	return in
}

// on returns a client for another server of the same installation sharing c's cookies.
func (c *client) on(e *testEnv) *client {
	return &client{env: e, hc: c.hc, bearer: c.bearer, noCSRF: c.noCSRF}
}

func (c *client) storageSettings() storage.Settings {
	c.env.t.Helper()
	var st storage.Settings
	c.expect("GET", storagePath, nil, 200, &st)
	return st
}

// waitFor polls cond every 50 ms for up to d.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out after %s waiting for %s", d, what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (e *testEnv) artifactBackend(id uuid.UUID) string {
	e.t.Helper()
	var b string
	if err := e.pool.QueryRow(e.ctx, `SELECT storage FROM artifacts WHERE id = $1`, id).Scan(&b); err != nil {
		e.t.Fatal(err)
	}
	return b
}

// riverEnqueuer gives the server River's insert-only client (as `qatlas server`).
func riverEnqueuer(t *testing.T) func(*Deps) {
	return func(d *Deps) {
		if err := worker.MigrateRiverUp(context.Background(), d.Pool, io.Discard); err != nil {
			t.Fatal(err)
		}
		client, err := worker.NewInsertOnlyClient(d.Pool, d.Logger)
		if err != nil {
			t.Fatal(err)
		}
		d.Enqueuer = worker.NewEnqueuer(client)
	}
}

// startWorker runs a worker (no usable runner: only maintenance jobs matter
// here) sharing the server's storage registry, like `qatlas all`.
func startWorker(t *testing.T, e *testEnv) {
	t.Helper()
	w, err := worker.New(worker.Config{
		Pool: e.pool, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MasterKey: testMasterKey,
		DataDir: e.cfg.DataDir, Storage: e.srv.Storage, RunnerCmd: "/definitely/not/a/runner main.js",
		Concurrency: 1, StopGrace: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker.Run: %v", err)
			}
		case <-time.After(30 * time.Second):
			t.Error("worker did not stop")
		}
	})
}

func waitMigration(t *testing.T, c *client, want string) storage.Settings {
	t.Helper()
	var st storage.Settings
	waitFor(t, 30*time.Second, "storage migration "+want, func() bool {
		st = c.storageSettings()
		return st.Migration != nil && (st.Migration.Status == want || st.Migration.Status == storage.MigrationFailed)
	})
	if st.Migration.Status != want {
		t.Fatalf("migration: %+v (error %v)", st.Migration, deref(st.Migration.Error))
	}
	return st
}

func deref(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

// Admin → Storage end to end against Garage: validation and probes, saving
// with an encrypted write-only secret, hot swap in this and another server
// process (NOTIFY), per-artifact backends with Range downloads, migrations in
// both directions through the River worker, permissions.
func TestStorageSettingsS3(t *testing.T) {
	s3cfg := s3test.Config(t)
	secret := s3cfg.SecretKey
	f := rnSetup(t, riverEnqueuer(t))
	e := f.e
	adminID := e.createUser("root@example.com", "Root", "admin", "active", testPassword)
	admin := e.browser()
	admin.login("root@example.com", testPassword)
	other := e.sibling() // a second server process on the same database
	admin2 := admin.on(other)

	// ---- default: local, nothing stored; every required key is rendered.
	raw := admin.expect("GET", storagePath, nil, 200, nil)
	var keys map[string]json.RawMessage
	raw.decode(t, &keys)
	for _, k := range []string{"active_backend", "source", "env_override", "s3", "artifacts", "migration", "updated_at", "updated_by", "warning"} {
		if _, ok := keys[k]; !ok {
			t.Fatalf("GET lacks %q: %s", k, raw.body)
		}
	}
	st := admin.storageSettings()
	if st.ActiveBackend != "local" || st.Source != "default" || st.EnvOverride || st.S3.SecretSet || st.S3.Region != "us-east-1" ||
		!st.S3.ForcePathStyle || st.Migration != nil || st.UpdatedAt != nil || st.UpdatedBy != nil || st.Warning != nil {
		t.Fatalf("default settings: %s", raw.body)
	}

	// ---- permissions: members 403, admin API tokens 403 (session only), CSRF.
	f.cE.expect("GET", storagePath, nil, 403, nil)
	f.cE.expect("PUT", storagePath, map[string]any{"backend": "local"}, 403, nil)
	f.cE.expect("POST", storagePath+"/test", map[string]any{"backend": "local"}, 403, nil)
	f.cE.expect("POST", storagePath+"/migrate", map[string]any{}, 403, nil)
	var tok auth.CreatedToken
	admin.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ci", "scopes": []string{"read", "write"}}, 201, &tok)
	e.bearer(tok.Secret).expect("GET", storagePath, nil, 403, nil)
	e.bearer(tok.Secret).expect("PUT", storagePath, map[string]any{"backend": "local"}, 403, nil)
	noCSRF := *admin
	noCSRF.noCSRF = true
	noCSRF.expect("PUT", storagePath, map[string]any{"backend": "local"}, 403, nil)

	// ---- a local artifact uploaded before the switch.
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	upPath := casePath(run, 0, "attachments")
	upload := func(c *client, name, body string) artifacts.Artifact {
		t.Helper()
		r := c.upload(upPath, "file", name, []byte(body), nil)
		if r.status != 201 {
			t.Fatalf("upload: %d %s", r.status, r.body)
		}
		var a artifacts.Artifact
		r.decode(t, &a)
		return a
	}
	localArt := upload(f.cE, "local.txt", "stored on the local disk")
	if b := e.artifactBackend(localArt.ID); b != "local" {
		t.Fatalf("local artifact backend %q", b)
	}

	// ---- PUT validation and probe failures: 422, nothing saved.
	saved := func() int { return e.count(`SELECT count(*) FROM system_settings WHERE key = 'storage'`) }
	fieldOf := func(r response) []string {
		var body struct {
			Error struct {
				Code    string `json:"code"`
				Details []struct{ Path, Message string }
			} `json:"error"`
		}
		r.decode(t, &body)
		if body.Error.Code != "validation_failed" {
			t.Fatalf("code %q: %s", body.Error.Code, r.body)
		}
		var paths []string
		for _, d := range body.Error.Details {
			paths = append(paths, d.Path)
		}
		return paths
	}
	bad := s3Input(s3cfg, secret)
	bad["endpoint"] = "garage.example.com/s3"
	bad["bucket"] = "No_Such"
	r := admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": bad}, 422, nil)
	if p := strings.Join(fieldOf(r), ","); p != "s3.endpoint,s3.bucket" {
		t.Fatalf("format errors: %s", r.body)
	}
	r = admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": s3Input(s3cfg, "")}, 422, nil)
	if p := strings.Join(fieldOf(r), ","); p != "s3.secret_access_key" {
		t.Fatalf("missing secret: %s", r.body)
	}
	admin.expect("PUT", storagePath, map[string]any{"backend": "s3"}, 422, nil)
	admin.expect("PUT", storagePath, map[string]any{"backend": "ftp"}, 422, nil)
	r = admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": s3Input(s3cfg, strings.Repeat("0", 64))}, 422, nil)
	if p := fieldOf(r); len(p) != 1 || p[0] != "checks.bucket" || !strings.Contains(string(r.body), "nothing was saved") {
		t.Fatalf("wrong secret: %s", r.body)
	}
	missingBucket := s3Input(s3cfg, secret)
	missingBucket["bucket"] = "qatlas-no-such-bucket"
	r = admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": missingBucket}, 422, nil)
	if p := fieldOf(r); len(p) != 1 || p[0] != "checks.bucket" || !strings.Contains(string(r.body), "does not exist") {
		t.Fatalf("missing bucket: %s", r.body)
	}
	down := s3Input(s3cfg, secret)
	down["endpoint"] = "http://127.0.0.1:1"
	r = admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": down}, 422, nil)
	if p := fieldOf(r); len(p) != 1 || p[0] != "checks.connect" {
		t.Fatalf("unreachable endpoint: %s", r.body)
	}
	if n := saved(); n != 0 || e.count(`SELECT count(*) FROM audit_logs WHERE action = 'settings.storage.update'`) != 0 {
		t.Fatalf("failed PUTs saved something: %d", n)
	}
	if b, _ := e.srv.Storage.Writer(); b != "local" {
		t.Fatalf("writer after failed PUTs: %s", b)
	}

	// ---- POST /test: per-check results, nothing saved.
	var tr storage.TestResult
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "s3", "s3": s3Input(s3cfg, secret)}, 200, &tr)
	if !tr.OK || len(tr.Checks) != 5 || tr.LatencyMS < 0 {
		t.Fatalf("test good: %+v", tr)
	}
	for i, name := range []string{"connect", "bucket", "write", "read", "delete"} {
		if tr.Checks[i].Name != name || !tr.Checks[i].OK || tr.Checks[i].Message == "" || tr.Checks[i].LatencyMS < 0 {
			t.Fatalf("check %d: %+v", i, tr.Checks[i])
		}
	}
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "s3", "s3": missingBucket}, 200, &tr)
	if tr.OK || !tr.Checks[0].OK || tr.Checks[1].OK || !strings.Contains(tr.Checks[1].Message, "does not exist") ||
		tr.Checks[2].OK || !strings.HasPrefix(tr.Message, "bucket: ") {
		t.Fatalf("test missing bucket: %+v", tr)
	}
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "s3", "s3": down}, 200, &tr)
	if tr.OK || tr.Checks[0].OK || tr.Checks[0].Name != "connect" {
		t.Fatalf("test unreachable: %+v", tr)
	}
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "local"}, 200, &tr)
	if !tr.OK {
		t.Fatalf("test local: %+v", tr)
	}
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "s3", "s3": s3Input(s3cfg, "")}, 422, nil) // no stored secret yet
	if saved() != 0 || len(s3test.Keys(t, s3cfg)) != 0 {
		t.Fatalf("test saved settings or left probe objects: %v", s3test.Keys(t, s3cfg))
	}

	// ---- PUT good: active s3 here and (via NOTIFY) in the other process.
	raw = admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": s3Input(s3cfg, secret)}, 200, &st)
	if st.ActiveBackend != "s3" || st.Source != "database" || st.EnvOverride || !st.S3.SecretSet || st.S3.SecretUpdatedAt == nil ||
		st.S3.Bucket != s3cfg.Bucket || st.S3.AccessKeyID != s3cfg.AccessKey || st.S3.Prefix != s3cfg.Prefix || st.UpdatedAt == nil ||
		st.UpdatedBy == nil || st.UpdatedBy.ID != adminID.String() || st.Warning != nil {
		t.Fatalf("after PUT: %s", raw.body)
	}
	firstSecretAt := *st.S3.SecretUpdatedAt
	waitFor(t, 10*time.Second, "the other server to switch to s3", func() bool {
		b, _ := other.srv.Storage.Writer()
		return b == "s3"
	})
	if st2 := admin2.storageSettings(); st2.ActiveBackend != "s3" || st2.Source != "database" {
		t.Fatalf("other server: %+v", st2)
	}

	// The secret is in no response, no audit row and not in plaintext in the database.
	for _, body := range [][]byte{raw.body, admin.expect("GET", storagePath, nil, 200, nil).body} {
		if bytes.Contains(body, []byte(secret)) || bytes.Contains(body, []byte("secret_access_key")) {
			t.Fatalf("secret in response: %s", body)
		}
	}
	var metaRaw []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT meta FROM audit_logs WHERE action = 'settings.storage.update' AND actor_user_id = $1`, adminID).Scan(&metaRaw); err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Backend         string   `json:"backend"`
		PreviousBackend string   `json:"previous_backend"`
		Changed         []string `json:"changed"`
		SecretReplaced  bool     `json:"secret_replaced"`
	}
	_ = json.Unmarshal(metaRaw, &meta)
	if bytes.Contains(metaRaw, []byte(secret)) || meta.Backend != "s3" || meta.PreviousBackend != "local" || !meta.SecretReplaced ||
		!strings.Contains(strings.Join(meta.Changed, ","), "backend,s3.endpoint") || !strings.Contains(strings.Join(meta.Changed, ","), "s3.secret_access_key") {
		t.Fatalf("audit meta: %s", metaRaw)
	}
	var enc []byte
	var value []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT secret_enc, value FROM system_settings WHERE key = 'storage'`).Scan(&enc, &value); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte(secret)) || bytes.Contains(value, []byte(secret)) {
		t.Fatal("secret stored in plaintext")
	}
	if pt, err := secrets.Open(testMasterKey, enc); err != nil || string(pt) != secret {
		t.Fatalf("sealed secret: %v", err)
	}

	// ---- new uploads land in S3 (storage=s3) — through either server.
	s3Art := upload(f.cE, "s3.txt", "stored in the bucket")
	if b := e.artifactBackend(s3Art.ID); b != "s3" {
		t.Fatalf("new artifact backend %q", b)
	}
	keysNow := s3test.Keys(t, s3cfg)
	if len(keysNow) != 1 || !strings.HasSuffix(keysNow[0], "/"+s3Art.ID.String()+".txt") {
		t.Fatalf("bucket keys %v", keysNow)
	}
	viaOther := upload(f.cE.on(other), "other.txt", "uploaded through the other server")
	if b := e.artifactBackend(viaOther.ID); b != "s3" {
		t.Fatalf("other server artifact backend %q", b)
	}

	// Both backends serve downloads with Range, from either server.
	checkDownloads := func(c *client, arts map[artifacts.Artifact]string) {
		t.Helper()
		for a, content := range arts {
			full := c.getRange(a.URL, "")
			if full.status != 200 || string(full.body) != content {
				t.Fatalf("download %s: %d %q", a.Name, full.status, full.body)
			}
			part := c.getRange(a.URL, "bytes=3-8")
			if part.status != 206 || string(part.body) != content[3:9] {
				t.Fatalf("range %s: %d %q", a.Name, part.status, part.body)
			}
		}
	}
	all := map[artifacts.Artifact]string{localArt: "stored on the local disk", s3Art: "stored in the bucket", viaOther: "uploaded through the other server"}
	checkDownloads(f.cE, all)
	checkDownloads(f.cE.on(other), all)
	st = admin.storageSettings()
	if st.Artifacts.Local != 1 || st.Artifacts.S3 != 2 || st.Artifacts.BytesLocal != 24 || st.Artifacts.BytesS3 != int64(20+33) {
		t.Fatalf("counts: %+v", st.Artifacts)
	}

	// ---- PUT omitting the secret keeps it (the probe passes with the stored one).
	admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": s3Input(s3cfg, "")}, 200, &st)
	if !st.S3.SecretSet || st.S3.SecretUpdatedAt == nil || !st.S3.SecretUpdatedAt.Equal(firstSecretAt) || st.ActiveBackend != "s3" {
		t.Fatalf("PUT without secret: %+v", st.S3)
	}
	if err := e.pool.QueryRow(e.ctx, `SELECT meta FROM audit_logs WHERE action = 'settings.storage.update' ORDER BY created_at DESC, id DESC LIMIT 1`).Scan(&metaRaw); err != nil {
		t.Fatal(err)
	}
	meta.Changed, meta.SecretReplaced = nil, true
	_ = json.Unmarshal(metaRaw, &meta)
	if meta.SecretReplaced || len(meta.Changed) != 0 {
		t.Fatalf("audit of PUT without secret: %s", metaRaw)
	}
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "s3", "s3": s3Input(s3cfg, "")}, 200, &tr) // stored secret
	if !tr.OK {
		t.Fatalf("test with stored secret: %+v", tr)
	}

	// ---- migrate local → s3 through the River worker; 409 while one is queued.
	admin.expect("POST", storagePath+"/migrate", nil, 202, &st)
	if st.Migration == nil || st.Migration.Status != "queued" || st.Migration.From != "local" || st.Migration.To != "s3" || st.Migration.Total != 1 {
		t.Fatalf("migration queued: %+v", st.Migration)
	}
	r = admin.expect("POST", storagePath+"/migrate", map[string]any{"delete_source": true}, 409, nil)
	if r.errCode(t) != "conflict" {
		t.Fatalf("second migration: %s", r.body)
	}
	startWorker(t, e)
	st = waitMigration(t, admin, "done")
	if m := st.Migration; m.Total != 1 || m.Copied != 1 || m.Failed != 0 || m.StartedAt == nil || m.FinishedAt == nil || m.Error != nil {
		t.Fatalf("migration done: %+v", m)
	}
	if st.Artifacts.Local != 0 || st.Artifacts.S3 != 3 || e.artifactBackend(localArt.ID) != "s3" {
		t.Fatalf("after migration: %+v", st.Artifacts)
	}
	if _, err := e.srv.Storage.Local().Stat(e.ctx, artifacts.StorageKey(f.shop, run.ID, localArt.ID, localArt.Name)); err != nil {
		t.Fatalf("local source removed without delete_source: %v", err)
	}
	checkDownloads(f.cE, all)

	// ---- switch back to local: S3 settings are kept, s3 artifacts stay readable.
	admin.expect("PUT", storagePath, map[string]any{"backend": "local"}, 200, &st)
	if st.ActiveBackend != "local" || st.Source != "database" || st.S3.Bucket != s3cfg.Bucket || !st.S3.SecretSet {
		t.Fatalf("back to local: %+v", st)
	}
	waitFor(t, 10*time.Second, "the other server to switch back to local", func() bool {
		b, _ := other.srv.Storage.Writer()
		return b == "local"
	})
	backAgain := upload(f.cE, "again.txt", "local once more")
	if b := e.artifactBackend(backAgain.ID); b != "local" {
		t.Fatalf("artifact after switching back: %q", b)
	}
	all[backAgain] = "local once more"
	checkDownloads(f.cE.on(other), all)

	// ---- migrate s3 → local, deleting the S3 copies.
	admin.expect("POST", storagePath+"/migrate", map[string]any{"delete_source": true}, 202, &st)
	if st.Migration.From != "s3" || st.Migration.To != "local" {
		t.Fatalf("reverse migration: %+v", st.Migration)
	}
	st = waitMigration(t, admin, "done")
	if st.Migration.Copied != 3 || st.Artifacts.S3 != 0 || st.Artifacts.Local != 4 {
		t.Fatalf("reverse migration done: %+v %+v", st.Migration, st.Artifacts)
	}
	if left := s3test.Keys(t, s3cfg); len(left) != 0 {
		t.Fatalf("S3 objects left after delete_source: %v", left)
	}
	checkDownloads(f.cE, all)
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'settings.storage.migrate'`); n != 2 {
		t.Fatalf("migrate audit rows: %d", n)
	}
}

// A broken S3 configuration in the database does not stop the server: new
// artifacts go to local storage and GET explains why; fixing it in the UI
// switches back without a restart.
func TestStorageSettingsBrokenAtStartup(t *testing.T) {
	s3cfg := s3test.Config(t)
	f := rnSetup(t)
	e := f.e
	e.createUser("root@example.com", "Root", "admin", "active", testPassword)

	// Settings saved earlier, now pointing at a bucket that is gone.
	enc, err := secrets.Seal(testMasterKey, []byte(s3cfg.SecretKey))
	if err != nil {
		t.Fatal(err)
	}
	value, _ := json.Marshal(map[string]any{"backend": "s3", "s3": map[string]any{
		"endpoint": s3cfg.Endpoint, "region": s3cfg.Region, "bucket": "qatlas-gone-bucket",
		"access_key_id": s3cfg.AccessKey, "prefix": s3cfg.Prefix, "force_path_style": true,
	}})
	rnExec(t, e, `INSERT INTO system_settings (key, value, secret_enc, secret_updated_at) VALUES ('storage', $1, $2, now())`, value, enc)

	broken := e.sibling(riverEnqueuer(t)) // starts after the row exists
	admin := broken.browser()
	admin.login("root@example.com", testPassword)
	st := admin.storageSettings()
	if st.ActiveBackend != "local" || st.Source != "database" || st.Warning == nil ||
		!strings.Contains(*st.Warning, "does not exist") || !strings.Contains(*st.Warning, "stored locally") {
		t.Fatalf("broken settings: %+v warning=%s", st, deref(st.Warning))
	}
	r := admin.expect("POST", storagePath+"/migrate", nil, 409, nil)
	if !strings.Contains(string(r.body), "unreachable") {
		t.Fatalf("migrate in fallback: %s", r.body)
	}
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	up := f.cE.on(broken).upload(casePath(run, 0, "attachments"), "file", "x.txt", []byte("fallback"), nil)
	if up.status != 201 {
		t.Fatalf("upload in fallback: %d %s", up.status, up.body)
	}
	var a artifacts.Artifact
	up.decode(t, &a)
	if b := e.artifactBackend(a.ID); b != "local" {
		t.Fatalf("fallback artifact backend %q", b)
	}

	// Fix the bucket in the UI, keeping the stored secret.
	admin.expect("PUT", storagePath, map[string]any{"backend": "s3", "s3": s3Input(s3cfg, "")}, 200, &st)
	if st.ActiveBackend != "s3" || st.Warning != nil {
		t.Fatalf("after fix: %+v warning=%s", st, deref(st.Warning))
	}
	up = f.cE.on(broken).upload(casePath(run, 0, "attachments"), "file", "y.txt", []byte("fixed"), nil)
	up.decode(t, &a)
	if up.status != 201 || e.artifactBackend(a.ID) != "s3" {
		t.Fatalf("upload after fix: %d %s", up.status, up.body)
	}
}

// QATLAS_STORAGE in the environment wins: read-only settings, PUT 409
// env_override. Artifacts on a backend that is not configured answer 503.
func TestStorageSettingsEnvOverride(t *testing.T) {
	f := rnSetup(t, func(d *Deps) { d.Config.StorageFromEnv, d.Config.Storage = true, config.StorageLocal })
	e := f.e
	e.createUser("root@example.com", "Root", "admin", "active", testPassword)
	admin := e.browser()
	admin.login("root@example.com", testPassword)

	st := admin.storageSettings()
	if st.Source != "env" || !st.EnvOverride || st.ActiveBackend != "local" {
		t.Fatalf("env settings: %+v", st)
	}
	r := admin.expect("PUT", storagePath, map[string]any{"backend": "local"}, 409, nil)
	if r.errCode(t) != storage.CodeEnvOverride || !strings.Contains(string(r.body), "QATLAS_STORAGE") {
		t.Fatalf("PUT with env override: %s", r.body)
	}
	if e.count(`SELECT count(*) FROM system_settings WHERE key = 'storage'`) != 0 {
		t.Fatal("PUT saved settings despite the env override")
	}
	var tr storage.TestResult
	admin.expect("POST", storagePath+"/test", map[string]any{"backend": "local"}, 200, &tr)
	if !tr.OK {
		t.Fatalf("test: %+v", tr)
	}
	// No River enqueuer on this server: migrations cannot start.
	admin.expect("POST", storagePath+"/migrate", nil, 503, nil)
	// The env S3 values are shown (never the secret).
	env := f.e.sibling(riverEnqueuer(t), func(d *Deps) {
		d.Config.S3 = config.S3Config{Endpoint: "https://garage.example.com", Region: "garage", Bucket: "qatlas-env",
			AccessKey: "GKenv", SecretKey: "env-secret-value", ForcePathStyle: true, Prefix: "p"}
	})
	envAdmin := admin.on(env)
	raw := envAdmin.expect("GET", storagePath, nil, 200, &st)
	if !st.EnvOverride || st.S3.Endpoint != "https://garage.example.com" || st.S3.Bucket != "qatlas-env" || st.S3.AccessKeyID != "GKenv" ||
		st.S3.Prefix != "p" || st.S3.Region != "garage" || !st.S3.SecretSet || bytes.Contains(raw.body, []byte("env-secret-value")) {
		t.Fatalf("env s3 values: %s", raw.body)
	}
	// Migrating is allowed under the override; nothing to move → done at once with total 0.
	envAdmin.expect("POST", storagePath+"/migrate", nil, 202, &st)
	if m := st.Migration; m == nil || m.Status != "done" || m.Total != 0 || m.From != "s3" || m.To != "local" || m.FinishedAt == nil {
		t.Fatalf("empty migration: %+v", st.Migration)
	}
	if n := e.count(`SELECT count(*) FROM river_job WHERE kind = 'storage_migrate'`); n != 0 {
		t.Fatalf("job enqueued for an empty migration: %d", n)
	}

	// An artifact recorded on S3 while no S3 is configured: a clear 503, not a crash.
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	up := f.cE.upload(casePath(run, 0, "attachments"), "file", "x.txt", []byte("hello"), nil)
	var a artifacts.Artifact
	up.decode(t, &a)
	rnExec(t, e, `UPDATE artifacts SET storage = 's3' WHERE id = $1`, a.ID)
	r = f.cE.getRange(a.URL, "")
	if r.status != 503 || r.errCode(t) != artifacts.CodeStorageUnavailable || !strings.Contains(string(r.body), "Admin → Storage") {
		t.Fatalf("unconfigured backend: %d %s", r.status, r.body)
	}
	if r := e.browser().getRange("/readyz", ""); r.status != 200 {
		t.Fatalf("readyz: %d %s", r.status, r.body)
	}
}

// Migration 0002 backfill: with QATLAS_STORAGE=s3 the existing rows move to s3, once.
func TestStorageBackfill(t *testing.T) {
	f := rnSetup(t)
	e := f.e
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	up := f.cE.upload(casePath(run, 0, "attachments"), "file", "x.txt", []byte("hello"), nil)
	var a artifacts.Artifact
	up.decode(t, &a)
	rnExec(t, e, `INSERT INTO system_settings (key, value) VALUES ('artifacts_storage_backfill', '{"pending": true}')`)

	local := &config.Config{Storage: "local"}
	if n, err := storage.Backfill(e.ctx, e.pool, local, nil); err != nil || n != 0 || e.artifactBackend(a.ID) != "local" {
		t.Fatalf("backfill without s3 env: %d %v", n, err)
	}
	if e.count(`SELECT count(*) FROM system_settings WHERE key = 'artifacts_storage_backfill'`) != 0 {
		t.Fatal("marker kept")
	}
	rnExec(t, e, `INSERT INTO system_settings (key, value) VALUES ('artifacts_storage_backfill', '{"pending": true}')`)
	s3env := &config.Config{Storage: "s3", StorageFromEnv: true}
	if n, err := storage.Backfill(e.ctx, e.pool, s3env, nil); err != nil || n != 1 || e.artifactBackend(a.ID) != "s3" {
		t.Fatalf("backfill with s3 env: %d %v", n, err)
	}
	rnExec(t, e, `UPDATE artifacts SET storage = 'local'`)
	if n, err := storage.Backfill(e.ctx, e.pool, s3env, nil); err != nil || n != 0 || e.artifactBackend(a.ID) != "local" {
		t.Fatalf("second backfill: %d %v", n, err)
	}
}
