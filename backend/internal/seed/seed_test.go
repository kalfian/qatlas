package seed

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

type countingEnqueuer struct{ n int }

func (e *countingEnqueuer) EnqueueRun(context.Context, pgx.Tx, uuid.UUID) error {
	e.n++
	return nil
}

func testConfig(t *testing.T) *config.Config {
	key := bytes.Repeat([]byte{7}, 32)
	return &config.Config{BaseURL: "http://qatlas.test", DataDir: t.TempDir(), MasterKey: key}
}

func queryStrings(t *testing.T, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args ...any) []string {
	t.Helper()
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		t.Fatal(err)
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDemoSeed(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()
	cfg := testConfig(t)
	f, err := loadFixture()
	if err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	enq := &countingEnqueuer{}
	opts := Options{TargetURL: "http://demo.test:8099/", MailpitURL: "http://mail.test:8025/", AdminToken: "adm_test", Runs: true, Enqueuer: enq, Out: &out}
	if err := Demo(ctx, pool, cfg, nil, opts); err != nil {
		t.Fatalf("seed: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "budi@tokoku.id") || !strings.Contains(out.String(), "http://qatlas.test/invite/") {
		t.Fatalf("invite link not printed:\n%s", out.String())
	}
	if enq.n != len(demoRuns) {
		t.Fatalf("enqueued %d runs, want %d", enq.n, len(demoRuns))
	}

	// Users: active ones log in with the default password, budi stays invited.
	users := queryStrings(t, pool, `SELECT email || ':' || system_role || ':' || status FROM users ORDER BY email`)
	if got := strings.Join(users, ","); got != "budi@tokoku.id:member:invited,dimas@tokoku.id:member:active,rina@tokoku.id:admin:active,sari@tokoku.id:member:active" {
		t.Fatalf("users: %s", got)
	}
	var hash string
	if err := pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE email = 'dimas@tokoku.id'`).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if ok, err := auth.VerifyPassword(DefaultPassword, hash); err != nil || !ok {
		t.Fatalf("dimas password: ok=%v err=%v", ok, err)
	}

	// Keys match the fixture (cases and flows were created in fixture order).
	for _, p := range f.Projects {
		cases := queryStrings(t, pool, `SELECT p.key || '-T' || t.seq FROM test_cases t JOIN projects p ON p.id = t.project_id WHERE p.key = $1 ORDER BY t.seq`, p.Key)
		if len(cases) != len(p.TestCases) {
			t.Fatalf("%s: %d test cases, want %d", p.Key, len(cases), len(p.TestCases))
		}
		for i, tc := range p.TestCases {
			if cases[i] != tc.Key {
				t.Fatalf("%s: case %d is %s, want %s", p.Key, i, cases[i], tc.Key)
			}
		}
		flowKeys := queryStrings(t, pool, `SELECT p.key || '-F' || f.seq FROM flows f JOIN projects p ON p.id = f.project_id WHERE p.key = $1 ORDER BY f.seq`, p.Key)
		if len(flowKeys) != len(p.Flows) {
			t.Fatalf("%s: %d flows, want %d", p.Key, len(flowKeys), len(p.Flows))
		}
	}
	if got := strings.Join(queryStrings(t, pool, `
		SELECT p.key || ':' || u.email || ':' || pm.role FROM project_members pm
		JOIN projects p ON p.id = pm.project_id JOIN users u ON u.id = pm.user_id ORDER BY p.key, u.email`), ","); got !=
		"PAY:dimas@tokoku.id:maintainer,PAY:sari@tokoku.id:editor,SHOP:dimas@tokoku.id:editor,SHOP:rina@tokoku.id:maintainer,SHOP:sari@tokoku.id:viewer" {
		t.Fatalf("members: %s", got)
	}
	if got := strings.Join(queryStrings(t, pool, `
		SELECT f.name || '<' || COALESCE(pf.name, '') FROM folders f JOIN projects p ON p.id = f.project_id
		LEFT JOIN folders pf ON pf.id = f.parent_id WHERE p.key = 'SHOP' ORDER BY f.name`), ","); got !=
		"API<,Auth<,Cart<,Catalog<,Checkout<,Email<,Payment<Checkout" {
		t.Fatalf("folders: %s", got)
	}

	// Environments: SHOP staging points at the target; other variables come from the fixture.
	envs := queryStrings(t, pool, `
		SELECT p.key || '/' || e.name || ':' || e.is_default || ':' || e.variables::text
		FROM environments e JOIN projects p ON p.id = e.project_id ORDER BY p.key, e.created_at`)
	want := []string{
		`PAY/sandbox:true:{"API_URL": "https://sandbox.pay.tokoku.id"}`,
		`SHOP/staging:true:{"API_URL": "http://demo.test:8099/api", "BASE_URL": "http://demo.test:8099", "MAILPIT_URL": "http://mail.test:8025"}`,
		`SHOP/production:false:{"API_URL": "https://api.tokoku.id", "BASE_URL": "https://tokoku.id"}`,
	}
	if strings.Join(envs, "\n") != strings.Join(want, "\n") {
		t.Fatalf("environments:\n%s", strings.Join(envs, "\n"))
	}
	secret := func(project, env, name string) string {
		t.Helper()
		var sealed []byte
		err := pool.QueryRow(ctx, `
			SELECT s.value_enc FROM environment_secrets s JOIN environments e ON e.id = s.environment_id
			JOIN projects p ON p.id = e.project_id WHERE p.key = $1 AND e.name = $2 AND s.name = $3`, project, env, name).Scan(&sealed)
		if err != nil {
			t.Fatalf("secret %s/%s/%s: %v", project, env, name, err)
		}
		plain, err := secrets.Open(cfg.MasterKey, sealed)
		if err != nil {
			t.Fatal(err)
		}
		return string(plain)
	}
	if v := secret("SHOP", "staging", "QA_PASSWORD"); v != DefaultQAPassword {
		t.Fatalf("QA_PASSWORD = %q", v)
	}
	if v := secret("SHOP", "production", "QA_PASSWORD"); v != DefaultQAPassword {
		t.Fatalf("production QA_PASSWORD = %q", v)
	}
	if v := secret("SHOP", "staging", "QA_TOTP_SEED"); v != DefaultQATOTPSeed {
		t.Fatalf("QA_TOTP_SEED = %q", v)
	}
	if v := secret("SHOP", "staging", "ADMIN_TOKEN"); v != "adm_test" {
		t.Fatalf("ADMIN_TOKEN = %q", v)
	}
	if v := secret("PAY", "sandbox", "API_KEY"); !strings.HasPrefix(v, "sk_sandbox_") || len(v) < 30 {
		t.Fatalf("API_KEY = %q", v)
	}

	// Idempotent: a second run changes nothing and enqueues nothing.
	countAll := func() string {
		var n1, n2, n3, n4 int
		if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM projects),
			(SELECT count(*) FROM test_cases), (SELECT count(*) FROM runs)`).Scan(&n1, &n2, &n3, &n4); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%d/%d/%d/%d", n1, n2, n3, n4)
	}
	before := countAll()
	out.Reset()
	enq.n = 0
	if err := Demo(ctx, pool, cfg, nil, opts); err != nil {
		t.Fatal(err)
	}
	if after := countAll(); after != before || enq.n != 0 || !strings.Contains(out.String(), "project SHOP exists, skipped") {
		t.Fatalf("second seed: %s → %s, enqueued %d\n%s", before, after, enq.n, out.String())
	}

	// --reset recreates the projects although runs exist; users are kept.
	out.Reset()
	if err := Demo(ctx, pool, cfg, nil, Options{Reset: true, Out: &out}); err != nil {
		t.Fatalf("reset: %v\n%s", err, out.String())
	}
	if got := countAll(); got != "4/2/26/0" {
		t.Fatalf("after reset: %s", got)
	}
	if !strings.Contains(out.String(), "project SHOP deleted (--reset)") || !strings.Contains(out.String(), "project SHOP created") {
		t.Fatalf("reset output:\n%s", out.String())
	}
}

func TestDemoSeedValidation(t *testing.T) {
	cfg := testConfig(t)
	if err := Demo(context.Background(), nil, cfg, nil, Options{Password: "short"}); err == nil || !strings.Contains(err.Error(), "--password") {
		t.Fatalf("short password: %v", err)
	}
	if err := Demo(context.Background(), nil, cfg, nil, Options{Runs: true}); err == nil || !strings.Contains(err.Error(), "enqueuer") {
		t.Fatalf("runs without enqueuer: %v", err)
	}
	cfg.MasterKey = nil
	if err := Demo(context.Background(), nil, cfg, nil, Options{}); err == nil || !strings.Contains(err.Error(), "QATLAS_MASTER_KEY") {
		t.Fatalf("no master key: %v", err)
	}
}
