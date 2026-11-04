package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// rnEnqueuer records EnqueueRun calls and checks that the run is visible inside
// the caller's transaction but not yet committed (transactional enqueue).
type rnEnqueuer struct {
	pool *pgxpool.Pool
	mu   sync.Mutex
	runs []uuid.UUID
	inTx []bool // run row visible through the tx
	out  []bool // run row visible through the pool (must be false: not committed yet)
	fail error
}

func (f *rnEnqueuer) EnqueueRun(ctx context.Context, tx pgx.Tx, runID uuid.UUID) error {
	var inTx, out bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM runs WHERE id = $1 AND status = 'queued')`, runID).Scan(&inTx); err != nil {
		return err
	}
	if err := f.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM runs WHERE id = $1 AND status = 'queued')`, runID).Scan(&out); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.runs = append(f.runs, runID)
	f.inTx = append(f.inTx, inTx)
	f.out = append(f.out, out)
	return f.fail
}

func (f *rnEnqueuer) calls() []uuid.UUID {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]uuid.UUID(nil), f.runs...)
}

var _ jobs.Enqueuer = (*rnEnqueuer)(nil)

type rnFixture struct {
	e                         *testEnv
	enq                       *rnEnqueuer
	shop                      uuid.UUID
	maint, ed, ed2, view      uuid.UUID
	cM, cE, cE2, cV, cOutside *client
	env                       uuid.UUID
	tcAuto, tcManual, tcAuto2 uuid.UUID
	tcManual2, tcInvalid      uuid.UUID
}

const rnSecret = "s3cr3t-value"

func rnSetup(t *testing.T) *rnFixture {
	t.Helper()
	f := &rnFixture{}
	f.e = newEnv(t, func(d *Deps) {
		f.enq = &rnEnqueuer{pool: d.Pool}
		d.Enqueuer = f.enq
	})
	e := f.e
	f.maint = e.createUser("mia@example.com", "Mia", "member", "active", testPassword)
	f.ed = e.createUser("eddie@example.com", "Eddie", "member", "active", testPassword)
	f.ed2 = e.createUser("erin@example.com", "Erin", "member", "active", testPassword)
	f.view = e.createUser("vic@example.com", "Vic", "member", "active", testPassword)
	e.createUser("out@example.com", "Out", "member", "active", testPassword)
	f.shop = e.createProject("SHOP", "Shop", false)
	e.addMember(f.shop, f.maint, "maintainer")
	e.addMember(f.shop, f.ed, "editor")
	e.addMember(f.shop, f.ed2, "editor")
	e.addMember(f.shop, f.view, "viewer")
	for _, x := range []struct {
		c     **client
		email string
	}{{&f.cM, "mia"}, {&f.cE, "eddie"}, {&f.cE2, "erin"}, {&f.cV, "vic"}, {&f.cOutside, "out"}} {
		*x.c = e.browser()
		(*x.c).login(x.email+"@example.com", testPassword)
	}

	f.env = db.NewID()
	rnExec(t, e, `INSERT INTO environments (id, project_id, name, is_default, variables) VALUES ($1, $2, 'Staging', true, '{"BASE_URL":"https://staging.example"}')`, f.env, f.shop)
	rnExec(t, e, `INSERT INTO environment_secrets (environment_id, name, value_enc) VALUES ($1, 'QA_PASSWORD', '\x00')`, f.env)

	f.tcAuto = f.testCase(1, "Login works", "automated", []map[string]any{
		{"id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/login"},
		{"id": "s2", "action": "fill", "selector": "label=Password", "value": "{{secret.QA_PASSWORD}}", "description": "Type the password"},
		{"id": "s3", "action": "click", "selector": "role=button[name='Sign in']", "enabled": false},
	})
	f.tcManual = f.testCase(2, "Check invoice by hand", "manual", []map[string]any{
		{"id": "m1", "action": "manual", "description": "Open {{env.BASE_URL}}/invoices", "expected": "List is shown"},
		{"id": "m2", "action": "manual", "description": "Download the PDF"},
	})
	f.tcAuto2 = f.testCase(3, "Checkout", "automated", []map[string]any{
		{"id": "a1", "action": "goto", "url": "{{env.BASE_URL}}/checkout"},
	})
	f.tcManual2 = f.testCase(4, "Sign the delivery", "manual", []map[string]any{
		{"id": "m1", "action": "manual", "description": "Sign"},
	})
	f.tcInvalid = f.testCase(5, "Broken", "automated", []map[string]any{
		{"id": "b1", "action": "goto"},
	})
	return f
}

func rnExec(t *testing.T, e *testEnv, sql string, args ...any) {
	t.Helper()
	if _, err := e.pool.Exec(e.ctx, sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

func (f *rnFixture) testCase(seq int, title, execution string, steps []map[string]any) uuid.UUID {
	f.e.t.Helper()
	id := db.NewID()
	raw, _ := json.Marshal(steps)
	rnExec(f.e.t, f.e, `UPDATE projects SET seq_case = GREATEST(seq_case, $2) WHERE id = $1`, f.shop, seq)
	rnExec(f.e.t, f.e, `INSERT INTO test_cases (id, project_id, seq, title, execution, steps, status) VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
		id, f.shop, seq, title, execution, raw)
	return id
}

type rnItem struct {
	tc   uuid.UUID
	cont bool
}

func (f *rnFixture) flow(seq int, name string, stop bool, items ...rnItem) uuid.UUID {
	f.e.t.Helper()
	id := db.NewID()
	rnExec(f.e.t, f.e, `INSERT INTO flows (id, project_id, seq, name, stop_on_failure) VALUES ($1, $2, $3, $4, $5)`, id, f.shop, seq, name, stop)
	for i, it := range items {
		rnExec(f.e.t, f.e, `INSERT INTO flow_items (id, flow_id, position, test_case_id, continue_on_failure) VALUES ($1, $2, $3, $4, $5)`,
			db.NewID(), id, i+1, it.tc, it.cont)
	}
	return id
}

func (f *rnFixture) create(c *client, body map[string]any) runs.Run {
	f.e.t.Helper()
	var run runs.Run
	c.expect("POST", "/api/v1/projects/SHOP/runs", body, 202, &run)
	return run
}

func (f *rnFixture) get(c *client, key string) runs.Run {
	f.e.t.Helper()
	var run runs.Run
	c.expect("GET", "/api/v1/runs/"+key, nil, 200, &run)
	return run
}

func stepPath(run runs.Run, ci, si int) string {
	return "/api/v1/runs/" + run.Key + "/cases/" + run.Cases[ci].ID.String() + "/steps/" + run.Cases[ci].Steps[si].ID.String() + "/manual-result"
}

func casePath(run runs.Run, ci int, tail string) string {
	return "/api/v1/runs/" + run.Key + "/cases/" + run.Cases[ci].ID.String() + "/" + tail
}

// ------------------------------------------------------------------ create

func TestRunCreateTestCase(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	run := f.create(f.cE, map[string]any{"test_case": "shop-t1", "options": map[string]any{"browser": "firefox", "video": "always"}})
	if run.Key != "SHOP-R1" || run.Status != "queued" || run.Kind != "test_case" || run.Trigger != "manual" || run.HasManual || run.Assignee != nil {
		t.Fatalf("run: %+v", run.RunSummary)
	}
	if run.Environment == nil || run.Environment.Name != "Staging" || run.Target.Key != "SHOP-T1" || run.TriggeredBy.Email != "eddie@example.com" {
		t.Fatalf("env/target: %+v", run.RunSummary)
	}
	var opts map[string]any
	_ = json.Unmarshal(run.Options, &opts)
	if opts["browser"] != "firefox" || opts["video"] != "always" || opts["headless"] != true || opts["screenshot"] != "on_failure" {
		t.Fatalf("options merge: %v", opts)
	}
	if len(run.Cases) != 1 || len(run.Cases[0].Steps) != 3 || run.ResumePosition != nil || run.CancelRequested {
		t.Fatalf("cases: %+v", run.Cases)
	}
	st := run.Cases[0].Steps
	if st[0].Summary != "Open https://staging.example/login" {
		t.Fatalf("summary env interpolation: %q", st[0].Summary)
	}
	if !strings.Contains(st[1].Summary, "••••") || strings.Contains(st[1].Summary, "QA_PASSWORD") || st[1].Description != "Type the password" {
		t.Fatalf("secret masking: %+v", st[1])
	}
	if st[2].StepID != "s3" || st[2].Status != "pending" || st[2].Action != "click" {
		t.Fatalf("disabled step row: %+v", st[2])
	}
	if run.Summary.Steps.Total != 3 || run.Summary.Cases.Total != 1 || run.Summary.Cases.Other != 1 {
		t.Fatalf("counts: %+v", run.Summary)
	}

	// Raw JSON shape: required nullable fields present.
	raw := f.cE.expect("GET", "/api/v1/runs/SHOP-R1", nil, 200, nil)
	var shape map[string]any
	_ = json.Unmarshal(raw.body, &shape)
	for _, k := range []string{"options", "shared_session", "stop_on_failure", "error_message", "cancel_requested", "resume_position", "cases", "duration_ms", "assignee"} {
		if _, ok := shape[k]; !ok {
			t.Errorf("Run.%s missing", k)
		}
	}
	c0 := shape["cases"].([]any)[0].(map[string]any)
	for _, k := range []string{"executed_by", "video", "attachments", "started_at", "duration_ms"} {
		if _, ok := c0[k]; !ok {
			t.Errorf("RunCase.%s missing", k)
		}
	}
	s0 := c0["steps"].([]any)[0].(map[string]any)
	for _, k := range []string{"screenshot", "details", "actual_result", "error_message", "duration_ms"} {
		if _, ok := s0[k]; !ok {
			t.Errorf("RunStep.%s missing", k)
		}
	}

	// Enqueued once, inside the creating (uncommitted) transaction.
	if calls := f.enq.calls(); len(calls) != 1 || calls[0] != run.ID || !f.enq.inTx[0] || f.enq.out[0] {
		t.Fatalf("enqueue: calls=%v inTx=%v out=%v", calls, f.enq.inTx, f.enq.out)
	}
	// Snapshot: secret names only, never values.
	var snap runs.Snapshot
	var rawSnap []byte
	if err := e.pool.QueryRow(e.ctx, `SELECT snapshot FROM runs WHERE id = $1`, run.ID).Scan(&rawSnap); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal(rawSnap, &snap)
	if snap.Environment == nil || len(snap.Environment.SecretNames) != 1 || snap.Environment.SecretNames[0] != "QA_PASSWORD" ||
		snap.Environment.Variables["BASE_URL"] != "https://staging.example" || len(snap.Cases) != 1 || len(snap.Cases[0].Steps) != 3 ||
		snap.Cases[0].RunCaseID != run.Cases[0].ID || snap.Cases[0].Steps[0]["url"] != "{{env.BASE_URL}}/login" {
		t.Fatalf("snapshot: %s", rawSnap)
	}
	if bytes.Contains(rawSnap, []byte(rnSecret)) {
		t.Fatal("snapshot leaks a secret value")
	}
	if n := e.count(`SELECT count(*) FROM test_cases WHERE id = $1 AND last_run_status = 'queued'`, f.tcAuto); n != 1 {
		t.Fatal("last_run_status not synced")
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'run.create' AND entity_id = 'SHOP-R1'`); n != 1 {
		t.Fatal("audit run.create missing")
	}

	// A failing enqueue rolls the whole creation back (same transaction).
	f.enq.fail = errors.New("queue down")
	f.cE.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T1"}, 500, nil)
	f.enq.fail = nil
	if n := e.count(`SELECT count(*) FROM runs`); n != 1 {
		t.Fatalf("runs after rolled back create = %d", n)
	}
	if n := e.count(`SELECT seq_run FROM projects WHERE id = $1`, f.shop); n != 1 {
		t.Fatalf("seq_run after rollback = %d", n)
	}
	if n := e.count(`SELECT count(*) FROM run_cases`); n != 1 {
		t.Fatal("run_cases leaked from rolled back create")
	}

	// Validation (422) and permissions.
	for _, tc := range []struct {
		body any
		code string
	}{
		{map[string]any{"test_case": "SHOP-T5"}, "validation_failed"},
		{map[string]any{"test_case": "SHOP-T99"}, "validation_failed"},
		{map[string]any{"test_case": "PAY-T1"}, "validation_failed"},
		{map[string]any{"flow": "SHOP-F9"}, "validation_failed"},
		{map[string]any{}, "validation_failed"},
		{map[string]any{"test_case": "SHOP-T1", "options": map[string]any{"retries": 5}}, "validation_failed"},
		{map[string]any{"test_case": "SHOP-T1", "environment_id": uuid.NewString()}, "validation_failed"},
		{map[string]any{"test_case": "SHOP-T1", "assignee_id": f.view.String()}, "validation_failed"},
	} {
		r := f.cE.expect("POST", "/api/v1/projects/SHOP/runs", tc.body, 422, nil)
		if r.errCode(t) != tc.code {
			t.Fatalf("%v: %s", tc.body, r.body)
		}
	}
	var invalid struct {
		Error struct {
			Details []struct{ Path string } `json:"details"`
		} `json:"error"`
	}
	f.cE.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T5"}, 422, &invalid)
	if len(invalid.Error.Details) == 0 || invalid.Error.Details[0].Path != "steps[0].url" {
		t.Fatalf("dsl details: %+v", invalid)
	}
	if r := f.cV.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T1"}, 403, nil); r.errCode(t) != "forbidden" {
		t.Fatal("viewer must not run")
	}
	f.cOutside.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T1"}, 404, nil)
	f.cOutside.expect("GET", "/api/v1/runs/SHOP-R1", nil, 404, nil)
	f.cV.expect("GET", "/api/v1/runs/SHOP-R1", nil, 200, nil)
	f.cV.expect("GET", "/api/v1/runs/SHOP-R404", nil, 404, nil)

	// Token runs are triggered "api"; a read-only token cannot run.
	var tok auth.CreatedToken
	f.cE.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "CI", "scopes": []string{"read", "run"}}, 201, &tok)
	var ro auth.CreatedToken
	f.cE.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "RO", "scopes": []string{"read"}}, 201, &ro)
	var viaToken runs.Run
	e.bearer(tok.Secret).expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T3", "environment_id": f.env.String()}, 202, &viaToken)
	if viaToken.Trigger != "api" || viaToken.Key != "SHOP-R2" {
		t.Fatalf("token run: %+v", viaToken.RunSummary)
	}
	e.bearer(ro.Secret).expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T3"}, 403, nil)

	// List + filters.
	var page struct {
		Data       []runs.RunSummary `json:"data"`
		NextCursor *string           `json:"next_cursor"`
	}
	f.cV.expect("GET", "/api/v1/projects/SHOP/runs", nil, 200, &page)
	if len(page.Data) != 2 || page.Data[0].Key != "SHOP-R2" || page.NextCursor != nil {
		t.Fatalf("list: %+v", page)
	}
	f.cV.expect("GET", "/api/v1/projects/SHOP/runs?limit=1", nil, 200, &page)
	if len(page.Data) != 1 || page.NextCursor == nil || *page.NextCursor != "1" {
		t.Fatalf("pagination: %+v", page)
	}
	for q, want := range map[string]int{
		"target=shop-t1":                 1,
		"target=login":                   1,
		"target=R2":                      1,
		"trigger=api":                    1,
		"kind=flow":                      0,
		"status=queued":                  2,
		"from=2000-01-01&to=2999-12-31":  2,
		"from=2999-01-01":                0,
		"target=SHOP-T1&trigger=manual":  1,
		"target=SHOP-T3&status=finished": 0,
	} {
		f.cV.expect("GET", "/api/v1/projects/SHOP/runs?"+q, nil, 200, &page)
		if len(page.Data) != want {
			t.Errorf("filter %s: %d runs, want %d", q, len(page.Data), want)
		}
	}
	f.cV.expect("GET", "/api/v1/projects/SHOP/runs?from=yesterday", nil, 400, nil)
}

// ------------------------------------------------------------------ manual

func TestManualRunExecution(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	if run.Status != "awaiting_manual" || run.Assignee == nil || run.Assignee.Email != "eddie@example.com" || !run.HasManual ||
		run.ResumePosition == nil || *run.ResumePosition != 1 || run.StartedAt == nil {
		t.Fatalf("manual run: %+v", run.RunSummary)
	}
	if run.Cases[0].Steps[0].Description != "Open https://staging.example/invoices" || run.Cases[0].Steps[0].Expected != "List is shown" {
		t.Fatalf("manual step display: %+v", run.Cases[0].Steps[0])
	}
	if len(f.enq.calls()) != 0 {
		t.Fatal("manual-first run must not enqueue")
	}

	// Only the assignee may record results.
	if r := f.cE2.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed"}, 403, nil); r.errCode(t) != "forbidden" {
		t.Fatal("non-assignee")
	}
	f.cV.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed"}, 403, nil)
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "bogus"}, 400, nil)
	f.cE.expect("PUT", "/api/v1/runs/"+run.Key+"/cases/"+run.Cases[0].ID.String()+"/steps/"+uuid.NewString()+"/manual-result", map[string]any{"status": "passed"}, 404, nil)
	f.cE.expect("PUT", "/api/v1/runs/"+run.Key+"/cases/"+uuid.NewString()+"/steps/x/manual-result", map[string]any{"status": "passed"}, 409, nil)

	var got runs.Run
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed", "actual_result": "Looks fine"}, 200, &got)
	c := got.Cases[0]
	if c.Status != "running" || c.ExecutedBy == nil || c.ExecutedBy.Email != "eddie@example.com" || c.StartedAt == nil ||
		c.Steps[0].Status != "passed" || c.Steps[0].ActualResult == nil || *c.Steps[0].ActualResult != "Looks fine" {
		t.Fatalf("after manual result: %+v", c)
	}
	// Omitted actual_result keeps the note; empty clears it.
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "blocked"}, 200, &got)
	if got.Cases[0].Steps[0].ActualResult == nil {
		t.Fatal("actual_result cleared by omission")
	}
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed", "actual_result": ""}, 200, &got)
	if got.Cases[0].Steps[0].ActualResult != nil {
		t.Fatal("empty actual_result must clear")
	}

	// Pending steps block completion.
	if r := f.cE.expect("POST", casePath(run, 0, "complete-manual"), nil, 409, nil); r.errCode(t) != "conflict" {
		t.Fatal("complete with pending")
	}
	f.cE.expect("PUT", stepPath(run, 0, 1), map[string]any{"status": "failed", "actual_result": "PDF is empty"}, 200, nil)
	f.cE.expect("POST", casePath(run, 0, "complete-manual"), nil, 200, &got)
	if got.Status != "failed" || got.FinishedAt == nil || got.ResumePosition != nil || got.Cases[0].Status != "failed" ||
		got.Cases[0].FinishedAt == nil || got.Cases[0].DurationMS == nil {
		t.Fatalf("completed: %+v / %+v", got.RunSummary, got.Cases[0])
	}
	if n := e.count(`SELECT count(*) FROM test_cases WHERE id = $1 AND last_run_status = 'failed'`, f.tcManual); n != 1 {
		t.Fatal("last_run_status after completion")
	}
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed"}, 409, nil)
	f.cE.expect("POST", casePath(run, 0, "complete-manual"), nil, 409, nil)

	// All-skipped manual case → skipped case, run passed (mock finalizeRun).
	run2 := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	f.cE.expect("PUT", stepPath(run2, 0, 0), map[string]any{"status": "skipped"}, 200, nil)
	f.cE.expect("PUT", stepPath(run2, 0, 1), map[string]any{"status": "skipped"}, 200, nil)
	f.cE.expect("POST", casePath(run2, 0, "complete-manual"), nil, 200, &got)
	if got.Cases[0].Status != "skipped" || got.Status != "passed" {
		t.Fatalf("all skipped: case %s run %s", got.Cases[0].Status, got.Status)
	}

	// Reassign: maintainers only; assignee must be editor/maintainer.
	run3 := f.create(f.cE, map[string]any{"test_case": "SHOP-T2", "assignee_id": f.ed2.String()})
	if run3.Assignee == nil || run3.Assignee.Email != "erin@example.com" {
		t.Fatalf("explicit assignee: %+v", run3.Assignee)
	}
	f.cE.expect("PATCH", "/api/v1/runs/"+run3.Key+"/assignee", map[string]any{"user_id": f.ed.String()}, 403, nil)
	f.cM.expect("PATCH", "/api/v1/runs/"+run3.Key+"/assignee", map[string]any{"user_id": f.view.String()}, 422, nil)
	f.cM.expect("PATCH", "/api/v1/runs/"+run3.Key+"/assignee", map[string]any{"user_id": f.ed.String()}, 200, &got)
	if got.Assignee == nil || got.Assignee.Email != "eddie@example.com" {
		t.Fatalf("reassign: %+v", got.Assignee)
	}
	f.cE.expect("PUT", stepPath(run3, 0, 0), map[string]any{"status": "passed"}, 200, nil)
}

func TestMixedFlowResume(t *testing.T) {
	f := rnSetup(t)
	e := f.e
	f.flow(1, "Order to delivery", true, rnItem{tc: f.tcManual}, rnItem{tc: f.tcAuto}, rnItem{tc: f.tcManual2})

	run := f.create(f.cE, map[string]any{"flow": "SHOP-F1"})
	if run.Kind != "flow" || run.Status != "awaiting_manual" || len(run.Cases) != 3 || !run.StopOnFailure || run.SharedSession ||
		*run.ResumePosition != 1 || run.Target.Title != "Order to delivery" {
		t.Fatalf("flow run: %+v", run)
	}
	if len(f.enq.calls()) != 0 {
		t.Fatal("manual-first flow must not enqueue")
	}
	// Case 2 is not in progress yet.
	f.cE.expect("POST", casePath(run, 1, "complete-manual"), nil, 409, nil)

	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "passed"}, 200, nil)
	f.cE.expect("PUT", stepPath(run, 0, 1), map[string]any{"status": "passed"}, 200, nil)
	var got runs.Run
	f.cE.expect("POST", casePath(run, 0, "complete-manual"), nil, 200, &got)
	if got.Status != "queued" || got.ResumePosition == nil || *got.ResumePosition != 2 || got.Cases[0].Status != "passed" {
		t.Fatalf("after manual case: %+v", got.RunSummary)
	}
	if calls := f.enq.calls(); len(calls) != 1 || calls[0] != run.ID || !f.enq.inTx[0] || f.enq.out[0] {
		t.Fatalf("resume enqueue: %v", calls)
	}

	// Simulate the worker: the automated segment passes, then runs.Continue.
	rnExec(t, e, `UPDATE run_steps SET status = 'passed' WHERE run_case_id = $1`, run.Cases[1].ID)
	rnExec(t, e, `UPDATE run_cases SET status = 'passed', started_at = now(), finished_at = now() WHERE id = $1`, run.Cases[1].ID)
	rnExec(t, e, `UPDATE runs SET status = 'running' WHERE id = $1`, run.ID)
	err := db.WithTx(e.ctx, e.pool, func(tx pgx.Tx) error {
		st, err := runs.Continue(e.ctx, tx, f.enq, run.ID)
		if err == nil && st != "awaiting_manual" {
			t.Errorf("Continue → %s", st)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	got = f.get(f.cE, run.Key)
	if got.Status != "awaiting_manual" || *got.ResumePosition != 3 {
		t.Fatalf("worker hand-off: %+v", got.RunSummary)
	}
	f.cE.expect("PUT", stepPath(run, 2, 0), map[string]any{"status": "passed"}, 200, nil)
	f.cE.expect("POST", casePath(run, 2, "complete-manual"), nil, 200, &got)
	if got.Status != "passed" || got.FinishedAt == nil || got.ResumePosition != nil || len(f.enq.calls()) != 1 {
		t.Fatalf("flow finished: %+v", got.RunSummary)
	}
	if n := e.count(`SELECT count(*) FROM flows WHERE last_run_status = 'passed'`); n != 1 {
		t.Fatal("flow last_run_status")
	}

	// stop_on_failure applies to manual results: the rest is skipped, nothing enqueued.
	run2 := f.create(f.cE, map[string]any{"flow": "SHOP-F1"})
	f.cE.expect("PUT", stepPath(run2, 0, 0), map[string]any{"status": "failed"}, 200, nil)
	f.cE.expect("PUT", stepPath(run2, 0, 1), map[string]any{"status": "skipped"}, 200, nil)
	f.cE.expect("POST", casePath(run2, 0, "complete-manual"), nil, 200, &got)
	if got.Status != "failed" || got.Cases[1].Status != "skipped" || got.Cases[2].Status != "skipped" ||
		got.Cases[1].Steps[0].Status != "skipped" || len(f.enq.calls()) != 1 {
		t.Fatalf("stop on failure: %+v", got)
	}

	// Rerun only_failed keeps failed/error/blocked/skipped cases.
	var re runs.Run
	f.cE.expect("POST", "/api/v1/runs/"+run2.Key+"/rerun", map[string]any{"only_failed": true}, 202, &re)
	if len(re.Cases) != 3 || re.Status != "awaiting_manual" {
		t.Fatalf("rerun all failed: %+v", re.RunSummary)
	}
	// A flow run whose case 1 passed: only cases 2 and 3 come back.
	rnExec(t, e, `UPDATE run_cases SET status = 'passed' WHERE run_id = $1 AND position = 1`, run2.ID)
	f.cE.expect("POST", "/api/v1/runs/"+run2.Key+"/rerun", map[string]any{"only_failed": true}, 202, &re)
	if len(re.Cases) != 2 || re.Cases[0].TestCaseKey != "SHOP-T1" || re.Cases[0].Position != 1 || re.Status != "queued" {
		t.Fatalf("rerun only failed: %+v", re.Cases)
	}
	if last := f.enq.calls(); last[len(last)-1] != re.ID {
		t.Fatal("rerun must enqueue")
	}
	// Nothing failed → 422; plain rerun works; viewer cannot rerun.
	f.cE.expect("POST", "/api/v1/runs/"+run.Key+"/rerun", map[string]any{"only_failed": true}, 422, nil)
	f.cE.expect("POST", "/api/v1/runs/"+run.Key+"/rerun", nil, 202, &re)
	if len(re.Cases) != 3 {
		t.Fatalf("full rerun: %d cases", len(re.Cases))
	}
	f.cV.expect("POST", "/api/v1/runs/"+run.Key+"/rerun", nil, 403, nil)

	// Shared-session flows can't contain manual cases (422).
	f.flow(2, "Shared", true, rnItem{tc: f.tcAuto}, rnItem{tc: f.tcManual})
	rnExec(t, e, `UPDATE flows SET shared_session = true WHERE seq = 2`)
	f.cE.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"flow": "SHOP-F2"}, 422, nil)
	// Flow with only disabled items → error run without job.
	fid := f.flow(3, "Empty", true, rnItem{tc: f.tcAuto})
	rnExec(t, e, `UPDATE flow_items SET enabled = false WHERE flow_id = $1`, fid)
	before := len(f.enq.calls())
	empty := f.create(f.cE, map[string]any{"flow": "SHOP-F3"})
	if empty.Status != "error" || empty.ErrorMessage == nil || *empty.ErrorMessage != "No enabled test cases to run" || empty.FinishedAt == nil || len(f.enq.calls()) != before {
		t.Fatalf("empty flow run: %+v", empty)
	}
}

// ------------------------------------------------------------------ cancel

func TestRunCancel(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	queued := f.create(f.cE, map[string]any{"test_case": "SHOP-T1"})
	f.cV.expect("POST", "/api/v1/runs/"+queued.Key+"/cancel", nil, 403, nil)
	if r := f.cE2.expect("POST", "/api/v1/runs/"+queued.Key+"/cancel", nil, 403, nil); !strings.Contains(string(r.body), "Only maintainers") {
		t.Fatalf("other editor: %s", r.body)
	}
	var got runs.Run
	f.cM.expect("POST", "/api/v1/runs/"+queued.Key+"/cancel", nil, 200, &got)
	if got.Status != "cancelled" || got.FinishedAt == nil || got.Cases[0].Status != "skipped" || got.Cases[0].Steps[0].Status != "skipped" {
		t.Fatalf("cancel queued: %+v", got)
	}
	if r := f.cM.expect("POST", "/api/v1/runs/"+queued.Key+"/cancel", nil, 409, nil); r.errCode(t) != "conflict" {
		t.Fatal("cancel final run")
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'run.cancel'`); n != 1 {
		t.Fatalf("cancel audit = %d", n)
	}

	running := f.create(f.cE, map[string]any{"test_case": "SHOP-T1"})
	rnExec(t, e, `UPDATE runs SET status = 'running', started_at = now() WHERE id = $1`, running.ID)
	rnExec(t, e, `UPDATE run_cases SET status = 'running' WHERE run_id = $1`, running.ID)
	f.cE.expect("POST", "/api/v1/runs/"+running.Key+"/cancel", nil, 200, &got)
	if got.Status != "running" || !got.CancelRequested || got.FinishedAt != nil {
		t.Fatalf("cancel running: %+v", got.RunSummary)
	}
	// Worker side: once stopped it closes the run.
	if err := db.WithTx(e.ctx, e.pool, func(tx pgx.Tx) error { return runs.FinishCancelled(e.ctx, tx, running.ID) }); err != nil {
		t.Fatal(err)
	}
	if got = f.get(f.cE, running.Key); got.Status != "cancelled" || got.Cases[0].Status != "skipped" {
		t.Fatalf("finish cancelled: %+v", got.RunSummary)
	}

	manual := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	f.cE.expect("POST", "/api/v1/runs/"+manual.Key+"/cancel", nil, 200, &got)
	if got.Status != "cancelled" || got.ResumePosition != nil {
		t.Fatalf("cancel awaiting_manual: %+v", got.RunSummary)
	}
	if n := e.count(`SELECT count(*) FROM test_cases WHERE id = $1 AND last_run_status = 'cancelled'`, f.tcManual); n != 1 {
		t.Fatal("last_run_status after cancel")
	}
}

// ------------------------------------------------------------------ attachments & artifacts

func (c *client) upload(path, field, filename string, content []byte, extra map[string]string) response {
	c.env.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range extra {
		_ = mw.WriteField(k, v)
	}
	if field != "" {
		fw, err := mw.CreateFormFile(field, filename)
		if err != nil {
			c.env.t.Fatal(err)
		}
		_, _ = fw.Write(content)
	}
	_ = mw.Close()
	req, _ := http.NewRequest("POST", c.env.http.URL+path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-QAtlas-CSRF", "1")
	res, err := c.hc.Do(req)
	if err != nil {
		c.env.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return response{status: res.StatusCode, body: data, header: res.Header}
}

func (c *client) getRange(path, rng string) response {
	c.env.t.Helper()
	req, _ := http.NewRequest("GET", c.env.http.URL+path, nil)
	if rng != "" {
		req.Header.Set("Range", rng)
	}
	res, err := c.hc.Do(req)
	if err != nil {
		c.env.t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return response{status: res.StatusCode, body: data, header: res.Header}
}

func TestManualAttachmentsAndArtifacts(t *testing.T) {
	f := rnSetup(t)
	e := f.e
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	path := casePath(run, 0, "attachments")
	content := []byte("hello, attachment world")

	if r := f.cE2.upload(path, "file", "x.txt", content, nil); r.status != 403 {
		t.Fatalf("non-assignee upload: %d", r.status)
	}
	if r := f.cE.upload(path, "", "", nil, nil); r.status != 400 {
		t.Fatalf("missing file: %d %s", r.status, r.body)
	}
	if r := f.cE.upload(path, "file", "x.txt", content, map[string]string{"run_step_id": uuid.NewString()}); r.status != 400 {
		t.Fatalf("foreign step: %d", r.status)
	}
	r := f.cE.upload(path, "file", "notes.txt", content, map[string]string{"run_step_id": run.Cases[0].Steps[1].ID.String()})
	if r.status != 201 {
		t.Fatalf("upload: %d %s", r.status, r.body)
	}
	var art artifacts.Artifact
	r.decode(t, &art)
	if art.Kind != "attachment" || art.Name != "notes.txt" || art.SizeBytes != int64(len(content)) || art.Expired ||
		art.URL != "/api/v1/artifacts/"+art.ID.String() || art.RunStepID == nil || *art.RunStepID != run.Cases[0].Steps[1].ID {
		t.Fatalf("artifact: %+v", art)
	}
	got := f.get(f.cE, run.Key)
	if len(got.Cases[0].Attachments) != 1 || got.Cases[0].Attachments[0].ID != art.ID {
		t.Fatalf("attachments in run: %+v", got.Cases[0].Attachments)
	}

	// Download: full, Range, RBAC.
	full := f.cV.getRange(art.URL, "")
	if full.status != 200 || !bytes.Equal(full.body, content) || full.header.Get("Accept-Ranges") != "bytes" ||
		!strings.Contains(full.header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("download: %d %q %v", full.status, full.body, full.header)
	}
	part := f.cE.getRange(art.URL, "bytes=7-16")
	if part.status != 206 || string(part.body) != "attachment" || part.header.Get("Content-Range") != "bytes 7-16/23" {
		t.Fatalf("range: %d %q %s", part.status, part.body, part.header.Get("Content-Range"))
	}
	if r := f.cOutside.getRange(art.URL, ""); r.status != 404 {
		t.Fatalf("outsider download: %d", r.status)
	}
	if r := f.cE.getRange("/api/v1/artifacts/not-a-uuid", ""); r.status != 404 {
		t.Fatalf("bad id: %d", r.status)
	}

	// 25 MB limit.
	big := bytes.Repeat([]byte("x"), runs.MaxAttachmentBytes+1)
	if r := f.cE.upload(path, "file", "big.bin", big, nil); r.status != 413 || r.errCode(t) != "too_large" {
		t.Fatalf("too large: %d %s", r.status, r.body)
	}
	if n := e.count(`SELECT count(*) FROM artifacts`); n != 1 {
		t.Fatalf("artifacts after rejected upload = %d", n)
	}

	// Retention: purge files older than artifact_retention_days → expired / 410.
	rnExec(t, e, `UPDATE artifacts SET created_at = now() - interval '31 days'`)
	n, err := artifacts.Purge(e.ctx, e.pool, e.srv.Artifacts.Store(), time.Now(), nil)
	if err != nil || n != 1 {
		t.Fatalf("purge: %d %v", n, err)
	}
	if r := f.cE.getRange(art.URL, ""); r.status != 410 || r.errCode(t) != "expired" {
		t.Fatalf("expired download: %d %s", r.status, r.body)
	}
	if got = f.get(f.cE, run.Key); !got.Cases[0].Attachments[0].Expired {
		t.Fatal("artifact not marked expired")
	}
	if n, _ := artifacts.Purge(e.ctx, e.pool, e.srv.Artifacts.Store(), time.Now(), nil); n != 0 {
		t.Fatal("purge is not idempotent")
	}
}

// ------------------------------------------------------------------ SSE

type sseStream struct {
	t      *testing.T
	cancel context.CancelFunc
	lines  chan string
}

func (c *client) sse(path string) (*sseStream, int) {
	c.env.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", c.env.http.URL+path, nil)
	res, err := c.hc.Do(req)
	if err != nil {
		cancel()
		c.env.t.Fatal(err)
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		cancel()
		return nil, res.StatusCode
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/event-stream" {
		c.env.t.Fatalf("content type %q", ct)
	}
	s := &sseStream{t: c.env.t, cancel: cancel, lines: make(chan string, 64)}
	go func() {
		defer res.Body.Close()
		defer close(s.lines)
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			s.lines <- sc.Text()
		}
	}()
	c.env.t.Cleanup(cancel)
	return s, 200
}

// waitFor reads lines until one equals want (or times out).
func (s *sseStream) waitFor(want string) []string {
	s.t.Helper()
	var seen []string
	timeout := time.After(10 * time.Second)
	for {
		select {
		case l, ok := <-s.lines:
			if !ok {
				s.t.Fatalf("stream closed before %q; saw %q", want, seen)
			}
			seen = append(seen, l)
			if l == want {
				return seen
			}
		case <-timeout:
			s.t.Fatalf("timeout waiting for %q; saw %q", want, seen)
		}
	}
}

func (s *sseStream) next() string {
	s.t.Helper()
	select {
	case l := <-s.lines:
		return l
	case <-time.After(10 * time.Second):
		s.t.Fatal("timeout reading SSE line")
	}
	return ""
}

func TestRunEventsSSE(t *testing.T) {
	f := rnSetup(t)
	e := f.e
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T1"})

	if _, status := f.cOutside.sse("/api/v1/runs/" + run.Key + "/events"); status != 404 {
		t.Fatalf("outsider SSE: %d", status)
	}
	if _, status := f.cV.sse("/api/v1/runs/SHOP-R99/events"); status != 404 {
		t.Fatalf("unknown run SSE: %d", status)
	}

	s, _ := f.cV.sse("/api/v1/runs/" + run.Key + "/events")
	s.waitFor(": connected")

	// A NOTIFY from anywhere (e.g. the worker) reaches the subscriber.
	if err := events.Notify(e.ctx, e.pool, events.Event{Type: events.StepFinished, RunKey: run.Key, RunStepID: "abc", Status: "passed"}); err != nil {
		t.Fatal(err)
	}
	s.waitFor("event: step_finished")
	var ev events.Event
	if data := s.next(); !strings.HasPrefix(data, "data: ") || json.Unmarshal([]byte(strings.TrimPrefix(data, "data: ")), &ev) != nil ||
		ev.RunKey != run.Key || ev.RunStepID != "abc" || ev.Status != "passed" {
		t.Fatalf("event data: %q", data)
	}
	// Events of other runs are not delivered; service changes are.
	_ = events.Notify(e.ctx, e.pool, events.Event{Type: events.RunStarted, RunKey: "SHOP-R999"})
	f.cE.expect("POST", "/api/v1/runs/"+run.Key+"/cancel", nil, 200, nil)
	seen := s.waitFor("event: run_finished")
	for _, l := range seen {
		if l == "event: run_started" {
			t.Fatal("received another run's event")
		}
	}

	// WaitForChange: final runs return immediately.
	actor := &auth.Actor{User: auth.User{ID: f.view, SystemRole: "member"}}
	got, changed, err := e.srv.Runs.WaitForChange(e.ctx, actor, run.Key, time.Second)
	if err != nil || changed || got.Status != "cancelled" {
		t.Fatalf("WaitForChange final: %v %v %v", got.Status, changed, err)
	}
	run2 := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	done := make(chan bool, 1)
	go func() {
		_, changed, _ := e.srv.Runs.WaitForChange(e.ctx, actor, run2.Key, 10*time.Second)
		done <- changed
	}()
	time.Sleep(300 * time.Millisecond)
	f.cE.expect("PUT", stepPath(run2, 0, 0), map[string]any{"status": "passed"}, 200, nil)
	select {
	case c := <-done:
		if !c {
			t.Fatal("WaitForChange did not see the change")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("WaitForChange hung")
	}
}
