package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/internal/dsl"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/secrets"
)

// End-to-end: real River client, real Node runner (runner/dist) and the demo target.
// Skips when the database, node, the runner build or Playwright's chromium is missing.

const qaPassword = "Qa-Staging-2026!"

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

// requireRunner skips unless node, the built runner and chromium are available.
func requireRunner(t *testing.T) (nodeBin, runnerMain, demoServer string) {
	t.Helper()
	root := repoRoot(t)
	nodeBin, err := exec.LookPath("node")
	if err != nil {
		t.Skip("integration test skipped: node not found in PATH")
	}
	runnerMain = filepath.Join(root, "runner", "dist", "main.js")
	if _, err := os.Stat(runnerMain); err != nil {
		t.Skip("integration test skipped: runner not built (corepack pnpm --filter @qatlas/runner build)")
	}
	demoServer = filepath.Join(root, "demo-target", "server.mjs")
	if _, err := os.Stat(demoServer); err != nil {
		t.Skip("integration test skipped: demo-target/server.mjs missing")
	}
	cmd := exec.Command(nodeBin, "-e", "process.stdout.write(require('playwright').chromium.executablePath())")
	cmd.Dir = filepath.Join(root, "runner")
	out, err := cmd.Output()
	if err != nil {
		t.Skipf("integration test skipped: cannot load playwright from runner/: %v", err)
	}
	if _, err := os.Stat(string(out)); err != nil {
		t.Skipf("integration test skipped: chromium for Playwright not installed (%s); run `npx playwright install chromium` in runner/", out)
	}
	return nodeBin, runnerMain, demoServer
}

// startDemo runs demo-target (Indonesian pages, DEMO_LANG=id: the steps below use them) on a random port and returns its base URL.
func startDemo(t *testing.T, nodeBin, server string) string {
	t.Helper()
	cmd := exec.Command(nodeBin, server)
	cmd.Env = append(os.Environ(), "PORT=0", "DEMO_LANG=id")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	line := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		if sc.Scan() {
			line <- sc.Text()
		}
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case l := <-line:
		m := regexp.MustCompile(`listening on (http://\S+)`).FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("unexpected demo-target output: %q", l)
		}
		return strings.Replace(m[1], "127.0.0.1", "localhost", 1)
	case <-time.After(15 * time.Second):
		t.Fatal("demo-target did not start")
	}
	return ""
}

// ------------------------------------------------------------------ fixtures

type fixture struct {
	t         *testing.T
	pool      *pgxpool.Pool
	userID    uuid.UUID
	projectID uuid.UUID
	envID     uuid.UUID
	baseURL   string
	key       []byte
	seq       int
}

type tcFixture struct {
	id        uuid.UUID
	key       string
	title     string
	execution string
	steps     []dsl.Step
	vars      map[string]string
}

func newFixture(t *testing.T, pool *pgxpool.Pool, baseURL string) *fixture {
	f := &fixture{t: t, pool: pool, baseURL: baseURL, key: make([]byte, 32),
		userID: db.NewID(), projectID: db.NewID(), envID: db.NewID()}
	copy(f.key, "integration-test-master-key-32b!")
	mustExec(t, pool, `INSERT INTO users (id, email, name, system_role, status) VALUES ($1, 'w@qatlas.local', 'Worker', 'admin', 'active')`, f.userID)
	mustExec(t, pool, `INSERT INTO projects (id, key, name, created_by) VALUES ($1, 'SHOP', 'Shop', $2)`, f.projectID, f.userID)
	vars, _ := json.Marshal(map[string]string{"BASE_URL": baseURL, "API_URL": baseURL + "/api"})
	mustExec(t, pool, `INSERT INTO environments (id, project_id, name, is_default, variables) VALUES ($1, $2, 'staging', true, $3)`, f.envID, f.projectID, vars)
	sealed, err := secrets.Seal(f.key, []byte(qaPassword))
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, pool, `INSERT INTO environment_secrets (environment_id, name, value_enc) VALUES ($1, 'QA_PASSWORD', $2)`, f.envID, sealed)
	return f
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

var stepSeq int

func step(action string, params map[string]any) dsl.Step {
	stepSeq++
	s := dsl.Step{"id": fmt.Sprintf("st_%d", stepSeq), "action": action}
	for k, v := range params {
		s[k] = v
	}
	return s
}

func (f *fixture) testCase(title, execution string, vars map[string]string, steps ...dsl.Step) tcFixture {
	f.seq++
	tc := tcFixture{id: db.NewID(), key: fmt.Sprintf("SHOP-T%d", f.seq), title: title, execution: execution, steps: steps, vars: vars}
	stepsJSON, _ := json.Marshal(steps)
	varsJSON, _ := json.Marshal(vars)
	if vars == nil {
		varsJSON = []byte("{}")
	}
	mustExec(f.t, f.pool, `INSERT INTO test_cases (id, project_id, seq, title, status, execution, steps, variables)
		VALUES ($1, $2, $3, $4, 'ready', $5, $6, $7)`, tc.id, f.projectID, f.seq, title, execution, stepsJSON, varsJSON)
	return tc
}

type runSpec struct {
	flow    bool
	shared  bool
	stop    bool
	options map[string]any
	cases   []tcFixture
}

type createdRun struct {
	id    uuid.UUID
	key   string
	cases []uuid.UUID
}

// createRun inserts a run the way internal/runs does (snapshot = runs.Snapshot) and
// enqueues run_execute in the same transaction.
func (f *fixture) createRun(enq jobs.Enqueuer, spec runSpec) createdRun {
	t := f.t
	ctx := context.Background()
	opts := map[string]any{"browser": "chromium", "headless": true, "viewport": map[string]any{"width": 1280, "height": 720},
		"screenshot": "on_failure", "video": "off", "step_timeout_ms": 5000, "retries": 0}
	for k, v := range spec.options {
		opts[k] = v
	}
	optsJSON, _ := json.Marshal(opts)
	kind, targetID, targetKey, title := runs.KindTestCase, spec.cases[0].id, spec.cases[0].key, spec.cases[0].title
	var flowID, tcID *uuid.UUID
	snap := runs.Snapshot{Kind: kind, Options: optsJSON,
		Environment: &runs.EnvSnapshot{ID: f.envID, Name: "staging",
			Variables:   map[string]string{"BASE_URL": f.baseURL, "API_URL": f.baseURL + "/api"},
			SecretNames: []string{"QA_PASSWORD"}}}
	if spec.flow {
		f.seq++
		fid := db.NewID()
		mustExec(t, f.pool, `INSERT INTO flows (id, project_id, seq, name, shared_session, stop_on_failure) VALUES ($1, $2, $3, 'Flow', $4, $5)`,
			fid, f.projectID, f.seq, spec.shared, spec.stop)
		kind, targetID, targetKey, title = runs.KindFlow, fid, fmt.Sprintf("SHOP-F%d", f.seq), "Flow"
		flowID = &fid
		snap.Kind = kind
		snap.Flow = &runs.FlowSnapshot{ID: fid, Key: targetKey, Name: title, Revision: 1,
			SharedSession: spec.shared, StopOnFailure: spec.stop, Variables: json.RawMessage(`{"email":"qa.bot@tokoku.id"}`)}
	} else {
		tcID = &targetID
	}
	out := createdRun{id: db.NewID()}
	for i, tc := range spec.cases {
		vars, _ := json.Marshal(tc.vars)
		rcID := db.NewID()
		out.cases = append(out.cases, rcID)
		snap.Cases = append(snap.Cases, runs.CaseSnapshot{RunCaseID: rcID, Position: i + 1, TestCaseID: tc.id,
			TestCaseKey: tc.key, Revision: 1, Title: tc.title, Execution: tc.execution, Variables: vars, Steps: tc.steps})
	}
	snapJSON, _ := json.Marshal(snap)
	status := runs.StatusQueued
	var resume *int
	if spec.cases[0].execution == runs.ExecutionManual {
		one := 1
		status, resume = runs.StatusAwaitingManual, &one
	}
	err := db.WithTx(ctx, f.pool, func(tx pgx.Tx) error {
		var seq int
		if err := tx.QueryRow(ctx, `UPDATE projects SET seq_run = seq_run + 1 WHERE id = $1 RETURNING seq_run`, f.projectID).Scan(&seq); err != nil {
			return err
		}
		out.key = fmt.Sprintf("SHOP-R%d", seq)
		if _, err := tx.Exec(ctx, `
			INSERT INTO runs (id, project_id, seq, kind, test_case_id, flow_id, target_key, target_title,
				environment_id, environment_name, status, triggered_by, shared_session, stop_on_failure,
				resume_position, options, snapshot)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'staging', $10, $11, $12, $13, $14, $15, $16)`,
			out.id, f.projectID, seq, kind, tcID, flowID, targetKey, title, f.envID, status, f.userID,
			spec.shared, spec.stop || !spec.flow, resume, optsJSON, snapJSON); err != nil {
			return err
		}
		for i, tc := range spec.cases {
			if _, err := tx.Exec(ctx, `INSERT INTO run_cases (id, run_id, position, test_case_id, test_case_key, test_case_revision, title, execution)
				VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`, out.cases[i], out.id, i+1, tc.id, tc.key, tc.title, tc.execution); err != nil {
				return err
			}
			for j, st := range tc.steps {
				if _, err := tx.Exec(ctx, `INSERT INTO run_steps (id, run_case_id, position, step_id, action, summary, continue_on_failure, enabled)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, db.NewID(), out.cases[i], j+1, st.ID(), st.Action(),
					dsl.Summarize(st), st.Bool("continue_on_failure"), st.Enabled()); err != nil {
					return err
				}
			}
		}
		if err := runs.SyncLastRunStatus(ctx, tx, out.id); err != nil {
			return err
		}
		if status == runs.StatusQueued {
			return enq.EnqueueRun(ctx, tx, out.id)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	return out
}

func waitStatus(t *testing.T, pool *pgxpool.Pool, runID uuid.UUID, timeout time.Duration, want ...string) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var status string
	for time.Now().Before(deadline) {
		if err := pool.QueryRow(context.Background(), `SELECT status FROM runs WHERE id = $1`, runID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		for _, w := range want {
			if status == w {
				return status
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("run %s: status %q, want one of %v", runID, status, want)
	return ""
}

type caseRow struct {
	Status   string
	Video    *uuid.UUID
	Duration *int
	Started  *time.Time
}

type stepRow struct {
	Status   string
	Error    *string
	Details  []byte
	Shot     *uuid.UUID
	Duration *int
}

func loadCase(t *testing.T, pool *pgxpool.Pool, id uuid.UUID) (caseRow, []stepRow) {
	t.Helper()
	ctx := context.Background()
	var c caseRow
	if err := pool.QueryRow(ctx, `SELECT status, video_artifact_id, duration_ms, started_at FROM run_cases WHERE id = $1`, id).
		Scan(&c.Status, &c.Video, &c.Duration, &c.Started); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT status, error_message, details, screenshot_artifact_id, duration_ms FROM run_steps WHERE run_case_id = $1 ORDER BY position`, id)
	if err != nil {
		t.Fatal(err)
	}
	steps, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (stepRow, error) {
		var s stepRow
		return s, r.Scan(&s.Status, &s.Error, &s.Details, &s.Shot, &s.Duration)
	})
	if err != nil {
		t.Fatal(err)
	}
	return c, steps
}

func joinStatuses(steps []stepRow) string {
	var s []string
	for _, st := range steps {
		s = append(s, st.Status)
	}
	return strings.Join(s, ",")
}

// artifactOnDisk checks the artifacts row and that its file exists in the store.
func artifactOnDisk(t *testing.T, pool *pgxpool.Pool, root string, id uuid.UUID, kind string) {
	t.Helper()
	var key, gotKind, mime string
	var size int64
	if err := pool.QueryRow(context.Background(), `SELECT storage_key, kind, mime, size_bytes FROM artifacts WHERE id = $1 AND expires_at IS NOT NULL`, id).
		Scan(&key, &gotKind, &mime, &size); err != nil {
		t.Fatalf("artifact %s: %v", id, err)
	}
	st, err := os.Stat(filepath.Join(root, filepath.FromSlash(key)))
	if err != nil || st.Size() != size || size == 0 || gotKind != kind {
		t.Fatalf("artifact %s (%s %s): file %v size %d", id, gotKind, mime, err, size)
	}
}

// ------------------------------------------------------------------ the test

func TestWorkerEndToEnd(t *testing.T) {
	pool := testutil.DB(t)
	nodeBin, runnerMain, demoServer := requireRunner(t)
	ctx := context.Background()
	if err := MigrateRiverUp(ctx, pool, io.Discard); err != nil {
		t.Fatal(err)
	}
	baseURL := startDemo(t, nodeBin, demoServer)
	f := newFixture(t, pool, baseURL)

	storeRoot := t.TempDir()
	store, err := artifacts.NewLocalStore(storeRoot)
	if err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if testing.Verbose() {
		logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	}

	// A run left `running` by a dead worker (no lock holder, no waiting job) → error.
	stale := f.testCase("Stale", "automated", nil, step("wait", map[string]any{"ms": 1}))
	staleRun := f.createRun(jobs.NoopEnqueuer{}, runSpec{cases: []tcFixture{stale}})
	mustExec(t, pool, `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, staleRun.id)
	mustExec(t, pool, `UPDATE run_cases SET status = 'running', started_at = now() WHERE id = $1`, staleRun.cases[0])

	w, err := New(Config{
		Pool: pool, Logger: logger, MasterKey: f.key, DataDir: dataDir, Store: store,
		RunnerCmd:   nodeBin + " " + runnerMain,
		Concurrency: 2, RunTimeout: 2 * time.Minute,
		CancelPoll: 100 * time.Millisecond, CancelGrace: 3 * time.Second,
		StopGrace: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- w.Run(runCtx) }()
	t.Cleanup(func() {
		stop()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("worker.Run: %v", err)
			}
		case <-time.After(60 * time.Second):
			t.Error("worker did not stop")
		}
	})
	enq := NewEnqueuer(w.Client())

	waitStatus(t, pool, staleRun.id, 10*time.Second, "error")
	var staleMsg string
	_ = pool.QueryRow(ctx, `SELECT error_message FROM runs WHERE id = $1`, staleRun.id).Scan(&staleMsg)
	if c, _ := loadCase(t, pool, staleRun.cases[0]); c.Status != "error" || staleMsg != workerRestartedMessage {
		t.Fatalf("recovery: case %s, message %q", c.Status, staleMsg)
	}

	// 1. Passing case using a secret (login), with a forced screenshot on one step.
	login := f.testCase("Login", "automated", map[string]string{"email": "qa.bot@tokoku.id"},
		step("goto", map[string]any{"url": "{{env.BASE_URL}}/login"}),
		step("fill", map[string]any{"selector": "label=Email", "value": "{{vars.email}}"}),
		step("fill", map[string]any{"selector": "label=Password", "value": "{{secret.QA_PASSWORD}}"}),
		step("click", map[string]any{"selector": "role=button[name='Masuk']"}),
		step("expect_url", map[string]any{"value": "/akun", "match": "contains"}),
		step("expect_visible", map[string]any{"selector": "text=Halo, QA Bot", "screenshot": true}),
		step("wait", map[string]any{"ms": 1, "enabled": false}),
	)
	// 2. Failing voucher case (expected Rp 81.000, demo shows Rp 90.000) + a secret in the
	//    expected value of a later step that is skipped.
	voucher := f.testCase("Voucher", "automated", nil,
		step("goto", map[string]any{"url": "{{env.BASE_URL}}/checkout"}),
		step("fill", map[string]any{"selector": "label=Kode voucher", "value": "HEMAT10"}),
		step("click", map[string]any{"selector": "role=button[name='Pakai']"}),
		step("expect_visible", map[string]any{"selector": "text=Voucher HEMAT10 dipakai"}),
		step("expect_text", map[string]any{"selector": "testid=grand-total", "value": "Rp 81.000", "match": "equals", "timeout_ms": 1500}),
		step("click", map[string]any{"selector": "role=button[name='Bayar sekarang']"}),
	)
	r1 := f.createRun(enq, runSpec{cases: []tcFixture{login}})
	r2 := f.createRun(enq, runSpec{cases: []tcFixture{voucher}})

	if s := waitStatus(t, pool, r1.id, 90*time.Second, "passed", "failed", "error"); s != "passed" {
		c, st := loadCase(t, pool, r1.cases[0])
		t.Fatalf("login run %s: case %s steps %s %+v", s, c.Status, joinStatuses(st), st)
	}
	c, st := loadCase(t, pool, r1.cases[0])
	if c.Status != "passed" || joinStatuses(st) != "passed,passed,passed,passed,passed,passed,skipped" || c.Duration == nil {
		t.Fatalf("login case: %+v steps %s", c, joinStatuses(st))
	}
	if st[5].Shot == nil {
		t.Fatal("step with screenshot:true must have a screenshot artifact")
	}
	artifactOnDisk(t, pool, storeRoot, *st[5].Shot, "screenshot")
	if !strings.Contains(string(st[5].Details), "visible") {
		t.Fatalf("assertion details: %s", st[5].Details)
	}
	var tcLast string
	_ = pool.QueryRow(ctx, `SELECT last_run_status FROM test_cases WHERE id = $1`, login.id).Scan(&tcLast)
	if tcLast != "passed" {
		t.Fatalf("test_cases.last_run_status = %q", tcLast)
	}

	if s := waitStatus(t, pool, r2.id, 90*time.Second, "passed", "failed", "error"); s != "failed" {
		t.Fatalf("voucher run: %s", s)
	}
	c, st = loadCase(t, pool, r2.cases[0])
	if c.Status != "failed" || joinStatuses(st) != "passed,passed,passed,passed,failed,skipped" {
		t.Fatalf("voucher case: %s steps %s", c.Status, joinStatuses(st))
	}
	if st[4].Error == nil || !strings.Contains(*st[4].Error, "Rp 90.000") || st[4].Shot == nil {
		t.Fatalf("failed step: %+v", st[4])
	}
	var details map[string]any
	_ = json.Unmarshal(st[4].Details, &details)
	if details["expected"] != "Rp 81.000" || details["actual"] != "Rp 90.000" {
		t.Fatalf("details: %s", st[4].Details)
	}
	artifactOnDisk(t, pool, storeRoot, *st[4].Shot, "screenshot")

	// 3. Mixed flow: automated → manual → automated. The worker stops at the manual case.
	product := f.testCase("Product", "automated", nil,
		step("goto", map[string]any{"url": "{{env.BASE_URL}}/produk/kaos-polos-hitam"}),
		step("expect_text", map[string]any{"selector": "testid=product-price", "value": "Rp 90.000", "match": "contains"}),
	)
	manual := f.testCase("Manual check", "manual", nil, step("manual", map[string]any{"instruction": "Look at it", "expected": "Fine"}))
	apiLogin := f.testCase("API login", "automated", nil,
		step("http_request", map[string]any{"method": "POST", "url": "{{env.API_URL}}/v1/auth/login", "body_type": "json",
			"body": `{"email":"{{vars.email}}","password":"{{secret.QA_PASSWORD}}"}`}),
		step("expect_status", map[string]any{"value": 201}),
		// Fails and echoes the secret in details.expected: must be masked in the DB.
		step("expect_json", map[string]any{"path": "$.data.token", "op": "eq", "value": "{{secret.QA_PASSWORD}}"}),
	)
	r3 := f.createRun(enq, runSpec{flow: true, stop: false, cases: []tcFixture{product, manual, apiLogin}})
	waitStatus(t, pool, r3.id, 90*time.Second, "awaiting_manual")
	var resume *int
	_ = pool.QueryRow(ctx, `SELECT resume_position FROM runs WHERE id = $1`, r3.id).Scan(&resume)
	if resume == nil || *resume != 2 {
		t.Fatalf("resume_position = %v", resume)
	}
	if c, _ := loadCase(t, pool, r3.cases[0]); c.Status != "passed" {
		t.Fatalf("flow case 1: %s", c.Status)
	}
	if c, _ := loadCase(t, pool, r3.cases[2]); c.Status != "pending" {
		t.Fatalf("flow case 3 must wait for the manual case: %s", c.Status)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "tmp", r3.id.String())); !os.IsNotExist(err) {
		t.Fatalf("artifact_dir must be removed after the job: %v", err)
	}

	// The tester completes the manual case; runs.Continue enqueues the next segment.
	err = db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `UPDATE run_steps SET status = 'passed' WHERE run_case_id = $1`, r3.cases[1]); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE run_cases SET status = 'passed', started_at = now(), finished_at = now() WHERE id = $1`, r3.cases[1]); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM runs WHERE id = $1 FOR UPDATE`, r3.id); err != nil {
			return err
		}
		_, err := runs.Continue(ctx, tx, enq, r3.id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitStatus(t, pool, r3.id, 90*time.Second, "passed", "failed", "error"); s != "failed" {
		t.Fatalf("flow after manual: %s", s)
	}
	c, st = loadCase(t, pool, r3.cases[2])
	if c.Status != "failed" || joinStatuses(st) != "passed,passed,failed" {
		t.Fatalf("api case: %s %s", c.Status, joinStatuses(st))
	}
	if !strings.Contains(string(st[0].Details), "201") {
		t.Fatalf("http details: %s", st[0].Details)
	}
	var leaks int
	_ = pool.QueryRow(ctx, `
		SELECT count(*) FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id
		WHERE c.run_id = ANY ($1) AND (s.details::text LIKE '%' || $2 || '%' OR s.error_message LIKE '%' || $2 || '%')`,
		[]uuid.UUID{r1.id, r2.id, r3.id}, qaPassword).Scan(&leaks)
	if leaks != 0 {
		t.Fatalf("%d steps contain the secret value", leaks)
	}
	if !strings.Contains(string(st[2].Details), MaskText) {
		t.Fatalf("secret in expected must be masked: %s", st[2].Details)
	}
	var flowLast string
	_ = pool.QueryRow(ctx, `SELECT last_run_status FROM flows WHERE id = (SELECT flow_id FROM runs WHERE id = $1)`, r3.id).Scan(&flowLast)
	if flowLast != "failed" {
		t.Fatalf("flows.last_run_status = %q", flowLast)
	}

	// 4. Shared session + video always: one video for the segment on the first case
	//    (the runner repeats case.finished for it).
	shared := f.createRun(enq, runSpec{flow: true, shared: true, stop: true, options: map[string]any{"video": "always"},
		cases: []tcFixture{product, f.testCase("Home", "automated", nil,
			step("goto", map[string]any{"url": "{{env.BASE_URL}}"}),
			step("expect_title", map[string]any{"value": "Tokoku", "match": "contains"}))}})
	if s := waitStatus(t, pool, shared.id, 90*time.Second, "passed", "failed", "error"); s != "passed" {
		t.Fatalf("shared session run: %s", s)
	}
	c1, _ := loadCase(t, pool, shared.cases[0])
	c2, _ := loadCase(t, pool, shared.cases[1])
	if c1.Video == nil || c2.Video != nil || c1.Status != "passed" || c2.Status != "passed" {
		t.Fatalf("shared video: case1 %+v case2 %+v", c1, c2)
	}
	artifactOnDisk(t, pool, storeRoot, *c1.Video, "video")

	// 5. Cancel while a step is running.
	slow := f.testCase("Slow", "automated", nil, step("wait", map[string]any{"ms": 20000}), step("wait", map[string]any{"ms": 1}))
	r5 := f.createRun(enq, runSpec{cases: []tcFixture{slow}})
	waitStatus(t, pool, r5.id, 30*time.Second, "running")
	deadline := time.Now().Add(20 * time.Second)
	for {
		var stepRunning bool
		_ = pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM run_steps WHERE run_case_id = $1 AND status = 'running')`, r5.cases[0]).Scan(&stepRunning)
		if stepRunning || time.Now().After(deadline) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	mustExec(t, pool, `UPDATE runs SET cancel_requested = true WHERE id = $1`, r5.id)
	start := time.Now()
	waitStatus(t, pool, r5.id, 15*time.Second, "cancelled")
	if time.Since(start) > 10*time.Second {
		t.Fatalf("cancel took %s", time.Since(start))
	}
	c, st = loadCase(t, pool, r5.cases[0])
	if c.Status != "skipped" || joinStatuses(st) != "skipped,skipped" {
		t.Fatalf("cancelled case: %s %s", c.Status, joinStatuses(st))
	}

	// Every job finished: no leftover artifact dirs.
	if ents, _ := os.ReadDir(filepath.Join(dataDir, "tmp")); len(ents) != 0 {
		t.Fatalf("leftover artifact dirs: %d", len(ents))
	}
}
