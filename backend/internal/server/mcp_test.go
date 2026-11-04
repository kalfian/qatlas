package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/events"
	qmcp "github.com/kalfian/qatlas/backend/internal/mcp"
)

var mcpToolNames = []string{
	"cancel_run", "create_flow", "create_test_case", "get_flow", "get_project", "get_run_report",
	"get_step_schema", "get_test_case", "list_flows", "list_folders", "list_projects", "list_runs",
	"list_test_cases", "run_flow", "run_test_case", "update_flow", "update_test_case",
	"validate_test_case", "wait_for_run",
}

// fakePNG is enough for an image/png artifact (the content is not decoded).
var fakePNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-qatlas-test-screenshot")

type mcpFixture struct {
	e        *testEnv
	enq      *rnEnqueuer
	shop     uuid.UUID
	ed       uuid.UUID
	browser  *client
	full     string // read+write+run
	fullID   uuid.UUID
	readOnly string
}

func mcpSetup(t *testing.T) *mcpFixture {
	t.Helper()
	f := &mcpFixture{}
	f.e = newEnv(t, func(d *Deps) {
		f.enq = &rnEnqueuer{pool: d.Pool}
		d.Enqueuer = f.enq
	})
	e := f.e
	f.ed = e.createUser("eddie@example.com", "Eddie", "member", "active", testPassword)
	f.shop = e.createProject("SHOP", "Shop", false)
	e.addMember(f.shop, f.ed, "editor")
	rnExec(t, e, `INSERT INTO environments (id, project_id, name, is_default, variables) VALUES ($1, $2, 'Staging', true, '{"BASE_URL":"https://staging.example"}')`, db.NewID(), f.shop)

	f.browser = e.browser()
	f.browser.login("eddie@example.com", testPassword)
	var tok auth.CreatedToken
	f.browser.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "claude", "scopes": []string{"read", "write", "run"}}, 201, &tok)
	f.full, f.fullID = tok.Secret, tok.Token.ID
	f.browser.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ro", "scopes": []string{"read"}}, 201, &tok)
	f.readOnly = tok.Secret
	return f
}

func (f *mcpFixture) connect(token string) *sdk.ClientSession {
	f.e.t.Helper()
	c := sdk.NewClient(&sdk.Implementation{Name: "qatlas-test", Version: "1"}, nil)
	cs, err := c.Connect(f.e.ctx, &sdk.StreamableClientTransport{
		Endpoint: f.e.http.URL + "/mcp", HTTPClient: qmcp.BearerClient(token), MaxRetries: -1,
	}, nil)
	if err != nil {
		f.e.t.Fatalf("connect: %v", err)
	}
	f.e.t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// call invokes a tool and returns the result plus its first text content.
func call(t *testing.T, cs *sdk.ClientSession, name string, args map[string]any) (*sdk.CallToolResult, string) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	text := ""
	if len(res.Content) > 0 {
		if tc, ok := res.Content[0].(*sdk.TextContent); ok {
			text = tc.Text
		}
	}
	return res, text
}

// ok calls a tool that must succeed and decodes its JSON text into out.
func ok(t *testing.T, cs *sdk.ClientSession, name string, args map[string]any, out any) string {
	t.Helper()
	res, text := call(t, cs, name, args)
	if res.IsError {
		t.Fatalf("%s(%v) failed: %s", name, args, text)
	}
	if out != nil {
		if err := json.Unmarshal([]byte(text), out); err != nil {
			t.Fatalf("%s: decode %q: %v", name, text, err)
		}
	}
	return text
}

type toolErr struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details []struct {
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"details"`
	} `json:"error"`
	Hint string `json:"hint"`
}

// fails calls a tool that must fail and returns the decoded tool error.
func fails(t *testing.T, cs *sdk.ClientSession, name string, args map[string]any) toolErr {
	t.Helper()
	res, text := call(t, cs, name, args)
	if !res.IsError {
		t.Fatalf("%s(%v) succeeded, want an error: %s", name, args, text)
	}
	var e toolErr
	if err := json.Unmarshal([]byte(text), &e); err != nil {
		t.Fatalf("%s: tool error is not JSON %q: %v", name, text, err)
	}
	return e
}

var loginSteps = []map[string]any{
	{"id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/login"},
	{"id": "s2", "action": "expect_visible", "selector": "role=heading[name='Sign in']", "description": "Login form is shown"},
}

func TestMCPAuthAndDiscovery(t *testing.T) {
	f := mcpSetup(t)
	e := f.e

	// Bearer only: no header, a malformed token, a revoked one and a cookie session are all 401.
	init := map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "x", "version": "1"}}}
	for _, c := range []*client{{env: e, hc: &http.Client{}}, e.bearer("qat_deadbeef_00000000000000000000000000000000"), f.browser} {
		r := c.do("POST", "/mcp", init)
		if r.status != 401 || r.errCode(t) != "unauthenticated" || !strings.HasPrefix(r.header.Get("WWW-Authenticate"), "Bearer") {
			t.Fatalf("unauthenticated /mcp: %d %s %v", r.status, r.body, r.header)
		}
	}
	c := sdk.NewClient(&sdk.Implementation{Name: "x", Version: "1"}, nil)
	if _, err := c.Connect(e.ctx, &sdk.StreamableClientTransport{Endpoint: e.http.URL + "/mcp", HTTPClient: qmcp.BearerClient("qat_bad"), MaxRetries: -1}, nil); err == nil {
		t.Fatal("connect with an invalid token succeeded")
	}

	cs := f.connect(f.full)
	var names []string
	for tool, err := range cs.Tools(e.ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, tool.Name)
		if tool.Description == "" || tool.InputSchema == nil {
			t.Errorf("tool %s lacks description or schema", tool.Name)
		}
	}
	slices.Sort(names)
	if !slices.Equal(names, mcpToolNames) {
		t.Fatalf("tools = %v\nwant    %v", names, mcpToolNames)
	}

	var projects struct {
		Projects []struct{ Key, Role string } `json:"projects"`
	}
	ok(t, cs, "list_projects", nil, &projects)
	if len(projects.Projects) != 1 || projects.Projects[0].Key != "SHOP" || projects.Projects[0].Role != "editor" {
		t.Fatalf("list_projects: %+v", projects)
	}
	var schema struct {
		StepSchema map[string]any `json:"step_schema"`
		Examples   []any          `json:"examples"`
	}
	ok(t, cs, "get_step_schema", nil, &schema)
	if schema.StepSchema["type"] != "object" || len(schema.Examples) != 3 {
		t.Fatalf("get_step_schema: %+v", schema)
	}
	var proj map[string]any
	ok(t, cs, "get_project", map[string]any{"project": "shop"}, &proj)
	if envs := proj["environments"].([]any); len(envs) != 1 || envs[0].(map[string]any)["name"] != "Staging" {
		t.Fatalf("get_project environments: %v", proj["environments"])
	}
	if e := fails(t, cs, "get_project", map[string]any{"project": "NOPE"}); e.Error.Code != "not_found" || e.Hint == "" {
		t.Fatalf("unknown project: %+v", e)
	}

	rr, err := cs.ReadResource(e.ctx, &sdk.ReadResourceParams{URI: "qatlas://docs/step-dsl"})
	if err != nil || !strings.Contains(rr.Contents[0].Text, "# QAtlas step DSL") {
		t.Fatalf("step-dsl resource: %v %v", err, rr)
	}
	var prompts []string
	for p, err := range cs.Prompts(e.ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		prompts = append(prompts, p.Name)
	}
	slices.Sort(prompts)
	if !slices.Equal(prompts, []string{"triage_failed_run", "write_test_case"}) {
		t.Fatalf("prompts: %v", prompts)
	}
	gp, err := cs.GetPrompt(e.ctx, &sdk.GetPromptParams{Name: "triage_failed_run", Arguments: map[string]string{"run_key": "shop-r9"}})
	if err != nil || !strings.Contains(gp.Messages[0].Content.(*sdk.TextContent).Text, `get_run_report(run_key="SHOP-R9"`) {
		t.Fatalf("triage prompt: %v %+v", err, gp)
	}
}

func TestMCPTestCasesAndFlows(t *testing.T) {
	f := mcpSetup(t)
	e := f.e
	ro := f.connect(f.readOnly)
	cs := f.connect(f.full)

	valid := map[string]any{"title": "Login page loads", "tags": []string{"auth", "smoke"}, "status": "ready", "steps": loginSteps}

	// A read-only token can read but not create.
	if er := fails(t, ro, "create_test_case", map[string]any{"project": "SHOP", "definition": valid}); er.Error.Code != "forbidden" || !strings.Contains(er.Error.Message, "write") {
		t.Fatalf("read token create: %+v", er)
	}
	if er := fails(t, ro, "run_test_case", map[string]any{"key": "SHOP-T1"}); er.Error.Code != "forbidden" {
		t.Fatalf("read token run: %+v", er)
	}

	// validate_test_case and create_test_case report per-path errors.
	invalid := map[string]any{"title": "Broken", "steps": []map[string]any{{"id": "s1", "action": "goto"}, {"id": "s1", "action": "teleport"}}}
	var v struct {
		Valid  bool
		Errors []struct{ Path, Message string }
	}
	ok(t, ro, "validate_test_case", map[string]any{"project": "SHOP", "definition": invalid}, &v)
	paths := func() (out []string) {
		for _, x := range v.Errors {
			out = append(out, x.Path)
		}
		return out
	}()
	if v.Valid || !slices.Contains(paths, "steps[0].url") || !slices.Contains(paths, "steps[1].id") || !slices.Contains(paths, "steps[1].action") {
		t.Fatalf("validate: %+v", v)
	}
	er := fails(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": invalid})
	if er.Error.Code != "validation_failed" || len(er.Error.Details) < 3 || er.Error.Details[0].Path == "" || !strings.Contains(er.Hint, "validate_test_case") {
		t.Fatalf("create invalid: %+v", er)
	}
	found := false
	for _, d := range er.Error.Details {
		found = found || (d.Path == "steps[0].url" && d.Message == "URL is required")
	}
	if !found {
		t.Fatalf("create invalid details: %+v", er.Error.Details)
	}

	var created struct {
		Key      string
		Revision int
	}
	ok(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": valid}, &created)
	if created.Key != "SHOP-T1" || created.Revision != 1 {
		t.Fatalf("create: %+v", created)
	}
	var tc struct {
		Key      string
		Revision int
		Tags     []string
		Steps    []map[string]any
	}
	ok(t, ro, "get_test_case", map[string]any{"key": "shop-t1"}, &tc)
	if tc.Revision != 1 || len(tc.Steps) != 2 || tc.Steps[1]["selector"] != "role=heading[name='Sign in']" {
		t.Fatalf("get_test_case: %+v", tc)
	}
	var list struct {
		TestCases  []struct{ Key string } `json:"test_cases"`
		NextCursor *string                `json:"next_cursor"`
	}
	ok(t, ro, "list_test_cases", map[string]any{"project": "SHOP", "tags": []string{"smoke"}}, &list)
	if len(list.TestCases) != 1 || list.NextCursor != nil {
		t.Fatalf("list_test_cases: %+v", list)
	}

	// update_test_case: partial change keeps the steps; a stale base_revision is a conflict.
	var upd struct{ Revision int }
	ok(t, cs, "update_test_case", map[string]any{"key": "SHOP-T1", "base_revision": 1, "definition": map[string]any{"priority": "high"}}, &upd)
	if upd.Revision != 2 {
		t.Fatalf("update: %+v", upd)
	}
	er = fails(t, cs, "update_test_case", map[string]any{"key": "SHOP-T1", "base_revision": 1, "definition": map[string]any{"title": "Overwrite"}})
	if er.Error.Code != "revision_conflict" || !strings.Contains(er.Error.Message, "current revision 2") || !strings.Contains(er.Hint, "get_test_case") {
		t.Fatalf("conflict: %+v", er)
	}
	ok(t, ro, "get_test_case", map[string]any{"key": "SHOP-T1"}, &tc)
	if tc.Revision != 2 || len(tc.Steps) != 2 {
		t.Fatalf("after update: %+v", tc)
	}

	// Flows by test case key; update_flow keeps omitted name/items.
	var flow struct {
		Key      string
		Revision int
	}
	ok(t, cs, "create_flow", map[string]any{"project": "SHOP", "name": "Smoke", "items": []map[string]any{{"test_case": "SHOP-T1"}}}, &flow)
	if flow.Key != "SHOP-F1" {
		t.Fatalf("create_flow: %+v", flow)
	}
	if er := fails(t, cs, "create_flow", map[string]any{"project": "SHOP", "name": "Bad", "items": []map[string]any{{"test_case": "SHOP-T99"}}}); er.Error.Code != "validation_failed" || er.Error.Details[0].Path != "items[0].test_case" {
		t.Fatalf("create_flow unknown case: %+v", er)
	}
	ok(t, cs, "update_flow", map[string]any{"key": "SHOP-F1", "base_revision": flow.Revision, "description": "Fast checks"}, nil)
	var got struct {
		Name        string
		Description string
		Items       []struct {
			TestCase string `json:"test_case"`
		}
	}
	ok(t, ro, "get_flow", map[string]any{"key": "SHOP-F1"}, &got)
	if got.Name != "Smoke" || got.Description != "Fast checks" || len(got.Items) != 1 || got.Items[0].TestCase != "SHOP-T1" {
		t.Fatalf("get_flow after update: %+v", got)
	}

	// Every successful mutation is audited with trigger=mcp and the token id.
	n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'mcp.tool_call' AND meta->>'trigger' = 'mcp' AND actor_token_id = $1`, f.fullID)
	if n != 4 { // create_test_case, update_test_case, create_flow, update_flow
		t.Fatalf("mcp audit entries = %d, want 4", n)
	}
}

func TestMCPRunReportAndLimits(t *testing.T) {
	f := mcpSetup(t)
	e := f.e
	cs := f.connect(f.full)
	ok(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": map[string]any{"title": "Login", "steps": loginSteps}}, nil)

	var started struct {
		RunKey      string `json:"run_key"`
		Status      string
		Environment string
	}
	ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "environment": "staging", "options": map[string]any{"screenshot": "every_step"}}, &started)
	if started.RunKey != "SHOP-R1" || started.Status != "queued" || started.Environment != "Staging" {
		t.Fatalf("run_test_case: %+v", started)
	}
	if len(f.enq.calls()) != 1 || e.count(`SELECT count(*) FROM runs WHERE trigger = 'mcp' AND api_token_id = $1`, f.fullID) != 1 {
		t.Fatal("run not enqueued / not marked trigger=mcp")
	}
	if er := fails(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "environment": "prod"}); er.Error.Code != "validation_failed" || !strings.Contains(er.Error.Details[0].Message, "Staging") {
		t.Fatalf("unknown environment: %+v", er)
	}

	// Still queued: wait_for_run times out and asks to poll again.
	start := time.Now()
	var st struct {
		Status string
		Done   bool
		Next   string
	}
	ok(t, cs, "wait_for_run", map[string]any{"run_key": "SHOP-R1", "timeout_s": 1}, &st)
	if st.Status != "queued" || st.Done || time.Since(start) < 900*time.Millisecond || !strings.Contains(st.Next, "wait_for_run") {
		t.Fatalf("wait (queued): %+v after %v", st, time.Since(start))
	}

	// Finish the run like the worker would: s1 passed, s2 failed with a screenshot.
	var runID, caseID uuid.UUID
	if err := e.pool.QueryRow(e.ctx, `SELECT r.id, c.id FROM runs r JOIN run_cases c ON c.run_id = r.id WHERE r.project_id = $1 AND r.seq = 1`, f.shop).Scan(&runID, &caseID); err != nil {
		t.Fatal(err)
	}
	stepIDs := map[string]uuid.UUID{}
	rows, _ := e.pool.Query(e.ctx, `SELECT step_id, id FROM run_steps WHERE run_case_id = $1`, caseID)
	for rows.Next() {
		var sid string
		var id uuid.UUID
		if err := rows.Scan(&sid, &id); err != nil {
			t.Fatal(err)
		}
		stepIDs[sid] = id
	}
	rows.Close()
	failed := stepIDs["s2"]
	shot, err := artifacts.Save(e.ctx, e.pool, e.srv.Artifacts.Stores(), f.shop, runID, &caseID, &failed, artifacts.KindScreenshot, "s2.png", "image/png", bytes.NewReader(fakePNG))
	if err != nil {
		t.Fatal(err)
	}
	rnExec(t, e, `UPDATE run_steps SET status = 'passed', duration_ms = 120 WHERE id = $1`, stepIDs["s1"])
	rnExec(t, e, `UPDATE run_steps SET status = 'failed', duration_ms = 10000, screenshot_artifact_id = $2,
		error_message = 'Timeout 10000ms exceeded waiting for role=heading[name=''Sign in'']',
		details = '{"expected":"visible","actual":"not found"}' WHERE id = $1`, failed, shot.ID)
	rnExec(t, e, `UPDATE run_cases SET status = 'failed', started_at = now(), finished_at = now(), duration_ms = 10120 WHERE id = $1`, caseID)
	rnExec(t, e, `UPDATE runs SET status = 'running', started_at = now() - interval '11 seconds' WHERE id = $1`, runID)

	// wait_for_run wakes up on the run event (LISTEN/NOTIFY hub), not on its timeout.
	finished := make(chan error, 1)
	go func() {
		time.Sleep(400 * time.Millisecond)
		if _, err := e.pool.Exec(e.ctx, `UPDATE runs SET status = 'failed', finished_at = now() WHERE id = $1`, runID); err != nil {
			finished <- err
			return
		}
		finished <- events.Notify(e.ctx, e.pool, events.Event{Type: events.RunFinished, RunKey: "SHOP-R1", Status: "failed"})
	}()
	start = time.Now()
	var done struct {
		Status   string
		Done     bool
		Failures []struct {
			Case   string
			StepID string `json:"step_id"`
			Error  string
		}
	}
	ok(t, cs, "wait_for_run", map[string]any{"run_key": "SHOP-R1", "timeout_s": 30}, &done)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("wait_for_run did not wake up on the run event (%v)", time.Since(start))
	}
	if done.Status != "failed" || !done.Done || len(done.Failures) != 1 || done.Failures[0].StepID != "s2" || !strings.Contains(done.Failures[0].Error, "Timeout") {
		t.Fatalf("wait (finished): %+v", done)
	}

	res, text := call(t, cs, "get_run_report", map[string]any{"run_key": "SHOP-R1", "include_screenshots": "failed"})
	if res.IsError {
		t.Fatalf("report: %s", text)
	}
	var report struct {
		Status string
		Cases  []struct {
			TestCase string `json:"test_case"`
			Status   string
			Steps    []struct {
				StepID     string `json:"step_id"`
				Status     string
				Error      *string
				Details    map[string]any
				Screenshot string
			}
		}
	}
	if err := json.Unmarshal([]byte(text), &report); err != nil {
		t.Fatal(err)
	}
	if report.Status != "failed" || len(report.Cases) != 1 || len(report.Cases[0].Steps) != 2 {
		t.Fatalf("report: %s", text)
	}
	s2 := report.Cases[0].Steps[1]
	if s2.Status != "failed" || s2.Error == nil || s2.Details["expected"] != "visible" || s2.Details["actual"] != "not found" || s2.Screenshot != "attached as image 1" {
		t.Fatalf("report step: %+v", s2)
	}
	var images []*sdk.ImageContent
	for _, c := range res.Content {
		if img, ok := c.(*sdk.ImageContent); ok {
			images = append(images, img)
		}
	}
	if len(images) != 1 || images[0].MIMEType != "image/png" || !bytes.Equal(images[0].Data, fakePNG) {
		t.Fatalf("screenshots: %d images", len(images))
	}
	res, _ = call(t, cs, "get_run_report", map[string]any{"run_key": "SHOP-R1", "include_screenshots": "none"})
	for _, c := range res.Content {
		if _, isImg := c.(*sdk.ImageContent); isImg {
			t.Fatal("include_screenshots=none returned an image")
		}
	}

	// At most 3 queued/running MCP runs per token; finished runs do not count.
	for i := 0; i < 3; i++ {
		ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1"}, nil)
	}
	er := fails(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1"})
	if er.Error.Code != "rate_limited" || !strings.Contains(er.Error.Message, "SHOP-R2") || !strings.Contains(er.Hint, "wait_for_run") {
		t.Fatalf("rate limit: %+v", er)
	}
	var cancelled struct{ Status string }
	ok(t, cs, "cancel_run", map[string]any{"run_key": "SHOP-R2"}, &cancelled)
	if cancelled.Status != "cancelled" {
		t.Fatalf("cancel: %+v", cancelled)
	}
	ok(t, cs, "create_flow", map[string]any{"project": "SHOP", "name": "Smoke", "items": []map[string]any{{"test_case": "SHOP-T1"}}}, nil)
	var flowRun struct {
		RunKey string `json:"run_key"`
		Status string
		Kind   string
	}
	ok(t, cs, "run_flow", map[string]any{"key": "SHOP-F1"}, &flowRun) // the cancelled run freed a slot
	if flowRun.Status != "queued" || flowRun.Kind != "flow" {
		t.Fatalf("run_flow: %+v", flowRun)
	}
	var runsList struct {
		Runs []struct {
			RunKey  string `json:"run_key"`
			Trigger string
		}
	}
	ok(t, cs, "list_runs", map[string]any{"project": "SHOP", "trigger": "mcp", "limit": 2}, &runsList)
	if len(runsList.Runs) != 2 || runsList.Runs[0].Trigger != "mcp" {
		t.Fatalf("list_runs: %+v", runsList)
	}
}

func TestMCPAwaitingManual(t *testing.T) {
	f := mcpSetup(t)
	cs := f.connect(f.full)
	ok(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": map[string]any{
		"title": "Check the invoice PDF", "execution": "manual",
		"steps": []map[string]any{{"id": "m1", "action": "manual", "description": "Open the invoice", "expected": "PDF is readable"}},
	}}, nil)
	var started struct {
		RunKey string `json:"run_key"`
		Status string
	}
	ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1"}, &started)
	if started.Status != "awaiting_manual" {
		t.Fatalf("manual run: %+v", started)
	}
	start := time.Now()
	var st struct {
		Status         string
		Done           bool
		AwaitingManual struct {
			Assignee string
			Case     string
		} `json:"awaiting_manual"`
	}
	ok(t, cs, "wait_for_run", map[string]any{"run_key": started.RunKey, "timeout_s": 60}, &st)
	if time.Since(start) > 5*time.Second {
		t.Fatalf("wait_for_run blocked on awaiting_manual for %v", time.Since(start))
	}
	if st.Status != "awaiting_manual" || st.Done || !strings.Contains(st.AwaitingManual.Assignee, "eddie@example.com") || !strings.HasPrefix(st.AwaitingManual.Case, "SHOP-T1") {
		t.Fatalf("wait (manual): %+v", st)
	}
	// Manual runs do not count against the concurrent-run limit.
	for i := 0; i < 3; i++ {
		ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1"}, nil)
	}
}

func TestMCPStdioProxy(t *testing.T) {
	f := mcpSetup(t)
	ctx, cancel := context.WithCancel(context.Background())
	serverSide, clientSide := sdk.NewInMemoryTransports()
	done := make(chan error, 1)
	go func() { done <- qmcp.ServeStdioProxy(ctx, qmcp.Endpoint(f.e.http.URL), f.readOnly, serverSide) }()

	c := sdk.NewClient(&sdk.Implementation{Name: "stdio-client", Version: "1"}, nil)
	cs, err := c.Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, err := range cs.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		n++
	}
	if n != len(mcpToolNames) {
		t.Fatalf("proxied tools = %d", n)
	}
	var projects struct {
		Projects []struct{ Key string } `json:"projects"`
	}
	ok(t, cs, "list_projects", nil, &projects)
	if len(projects.Projects) != 1 || projects.Projects[0].Key != "SHOP" {
		t.Fatalf("proxied list_projects: %+v", projects)
	}
	if er := fails(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": map[string]any{"title": "x"}}); er.Error.Code != "forbidden" {
		t.Fatalf("proxied scope check: %+v", er)
	}
	rr, err := cs.ReadResource(ctx, &sdk.ReadResourceParams{URI: "qatlas://docs/step-dsl"})
	if err != nil || len(rr.Contents) != 1 {
		t.Fatalf("proxied resource: %v", err)
	}
	_ = cs.Close()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("proxy: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("proxy did not stop")
	}
}
