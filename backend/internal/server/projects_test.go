package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/devices"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/projects"
)

type projectList struct {
	Data []projects.ProjectSummary `json:"data"`
}

func projectKeys(l projectList) string {
	keys := make([]string, len(l.Data))
	for i, p := range l.Data {
		keys[i] = p.Key
	}
	return strings.Join(keys, ",")
}

type apiErr struct {
	Error struct {
		Code    string             `json:"code"`
		Message string             `json:"message"`
		Details []httpx.FieldError `json:"details"`
	} `json:"error"`
}

func TestProjectsVisibility(t *testing.T) {
	e := newEnv(t)
	e.createUser("admin@x.io", "Ada", "admin", "active", testPassword)
	mia := e.createUser("mia@x.io", "Mia", "member", "active", testPassword)
	e.createUser("bob@x.io", "Bob", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.createProject("PAY", "Payment", false)
	old := e.createProject("OLD", "Old", true)
	e.addMember(shop, mia, "editor")
	e.addMember(old, mia, "viewer")

	m := e.browser()
	m.login("mia@x.io", testPassword)
	var list projectList
	m.expect("GET", "/api/v1/projects", nil, 200, &list)
	if projectKeys(list) != "SHOP" || list.Data[0].MyRole != "editor" {
		t.Fatalf("member list: %+v", list.Data)
	}
	m.expect("GET", "/api/v1/projects?include_archived=true", nil, 200, &list)
	if projectKeys(list) != "SHOP,OLD" || list.Data[1].ArchivedAt == nil || list.Data[1].MyRole != "viewer" {
		t.Fatalf("member list with archived: %+v", list.Data)
	}
	if r := m.expect("GET", "/api/v1/projects/PAY", nil, 404, nil); r.errCode(t) != "not_found" {
		t.Fatal("non-member must get 404")
	}
	var p projects.Project
	m.expect("GET", "/api/v1/projects/old", nil, 200, &p) // archived stays reachable by key
	if p.Key != "OLD" || p.ArchivedAt == nil || p.MyRole != "viewer" {
		t.Fatalf("archived project: %+v", p)
	}
	if r := m.expect("POST", "/api/v1/projects", map[string]string{"key": "NEW", "name": "New"}, 403, nil); r.errCode(t) != "forbidden" {
		t.Fatal("members cannot create projects")
	}

	// Raw shape: required nullable fields present.
	raw := m.expect("GET", "/api/v1/projects", nil, 200, nil)
	var shape struct {
		Data []map[string]any `json:"data"`
	}
	raw.decode(t, &shape)
	for _, k := range []string{"id", "key", "name", "description", "archived_at", "my_role", "test_case_count", "flow_count", "last_run", "pass_rate_7d"} {
		if _, ok := shape.Data[0][k]; !ok {
			t.Errorf("ProjectSummary.%s missing", k)
		}
	}

	b := e.browser()
	b.login("bob@x.io", testPassword)
	b.expect("GET", "/api/v1/projects", nil, 200, &list)
	if len(list.Data) != 0 {
		t.Fatalf("outsider sees %v", projectKeys(list))
	}

	a := e.browser()
	a.login("admin@x.io", testPassword)
	a.expect("GET", "/api/v1/projects", nil, 200, &list)
	if projectKeys(list) != "SHOP,PAY" || list.Data[1].MyRole != "maintainer" {
		t.Fatalf("admin list: %+v", list.Data)
	}
	a.expect("GET", "/api/v1/projects?include_archived=true", nil, 200, &list)
	if len(list.Data) != 3 {
		t.Fatalf("admin list with archived: %v", projectKeys(list))
	}

	// A token restricted to SHOP only lists SHOP and cannot reach PAY.
	var tok auth.CreatedToken
	a.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ci", "scopes": []string{"read"}, "project_keys": []string{"SHOP"}}, 201, &tok)
	bt := e.bearer(tok.Secret)
	bt.expect("GET", "/api/v1/projects", nil, 200, &list)
	if projectKeys(list) != "SHOP" {
		t.Fatalf("restricted token list: %v", projectKeys(list))
	}
	bt.expect("GET", "/api/v1/projects/PAY", nil, 404, nil)
	bt.expect("POST", "/api/v1/projects", map[string]string{"key": "TOK", "name": "Tok"}, 403, nil) // read scope only
}

func TestProjectCreate(t *testing.T) {
	e := newEnv(t)
	adminID := e.createUser("admin@x.io", "Ada", "admin", "active", testPassword)
	a := e.browser()
	a.login("admin@x.io", testPassword)

	var p projects.Project
	a.expect("POST", "/api/v1/projects", map[string]any{"key": "shop", "name": "  Shop  ", "description": "Web shop"}, 201, &p)
	if p.Key != "SHOP" || p.Name != "Shop" || p.Description != "Web shop" || p.MyRole != "maintainer" || p.ArchivedAt != nil ||
		p.ArtifactRetentionDays != 30 || !p.DefaultRunOptions.Equal(projects.DefaultRunOptions()) {
		t.Fatalf("created: %+v", p)
	}
	if n := e.count(`SELECT count(*) FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'maintainer'`, p.ID, adminID); n != 1 {
		t.Fatal("creator must be maintainer")
	}
	var envs struct {
		Data []struct {
			Name      string            `json:"name"`
			IsDefault bool              `json:"is_default"`
			Variables map[string]string `json:"variables"`
		} `json:"data"`
	}
	a.expect("GET", "/api/v1/projects/SHOP/environments", nil, 200, &envs)
	if len(envs.Data) != 1 || envs.Data[0].Name != "staging" || !envs.Data[0].IsDefault || envs.Data[0].Variables["BASE_URL"] != "https://staging.example.com" {
		t.Fatalf("default environment: %+v", envs.Data)
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'project.create' AND project_id = $1`, p.ID); n != 1 {
		t.Fatal("project.create not audited")
	}
	me := a.login("admin@x.io", testPassword)
	if len(me.Projects) != 1 || me.Projects[0].Key != "SHOP" {
		t.Fatalf("me.projects: %+v", me.Projects)
	}

	for _, key := range []string{"", "S", "1AB", "ABCDEFGHIJK", "AB-1", "AB C"} {
		r := a.expect("POST", "/api/v1/projects", map[string]string{"key": key, "name": "X"}, 400, nil)
		var body apiErr
		r.decode(t, &body)
		if body.Error.Code != "validation_failed" || len(body.Error.Details) != 1 || body.Error.Details[0].Path != "key" {
			t.Fatalf("key %q: %s", key, r.body)
		}
	}
	r := a.expect("POST", "/api/v1/projects", map[string]string{"key": "Shop", "name": "Again"}, 409, nil)
	var body apiErr
	r.decode(t, &body)
	if body.Error.Code != "conflict" || body.Error.Message != "Key SHOP is already taken" || body.Error.Details[0].Path != "key" {
		t.Fatalf("duplicate key: %s", r.body)
	}
	r = a.expect("POST", "/api/v1/projects", map[string]string{"key": "NEW", "name": "  "}, 400, nil)
	r.decode(t, &body)
	if body.Error.Details[0].Path != "name" {
		t.Fatalf("missing name: %s", r.body)
	}
}

func TestProjectUpdateAndArchive(t *testing.T) {
	e := newEnv(t)
	mara := e.createUser("mara@x.io", "Mara", "member", "active", testPassword)
	eddy := e.createUser("eddy@x.io", "Eddy", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, mara, "maintainer")
	e.addMember(shop, eddy, "editor")
	m, ed := e.browser(), e.browser()
	m.login("mara@x.io", testPassword)
	ed.login("eddy@x.io", testPassword)

	ed.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"name": "Nope"}, 403, nil)
	ed.expect("POST", "/api/v1/projects/SHOP/archive", nil, 403, nil)

	var p projects.Project
	m.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{
		"name": "Shop Web", "description": "d", "artifact_retention_days": 90,
		"default_run_options": map[string]any{"video": "always", "viewport": map[string]int{"width": 1920, "height": 1080}},
	}, 200, &p)
	want := projects.DefaultRunOptions()
	want.Video, want.Viewport = "always", projects.Viewport{Width: 1920, Height: 1080}
	fhd, _ := devices.Preset("desktop-fhd")
	want.Devices = []devices.Device{fhd} // a lone viewport becomes one device
	if p.Name != "Shop Web" || p.Description != "d" || p.ArtifactRetentionDays != 90 || !p.DefaultRunOptions.Equal(want) || p.MyRole != "maintainer" {
		t.Fatalf("updated: %+v", p)
	}
	// Second partial merge keeps earlier changes.
	m.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"default_run_options": map[string]any{"retries": 2}}, 200, &p)
	want.Retries = 2
	if !p.DefaultRunOptions.Equal(want) {
		t.Fatalf("merged options: %+v", p.DefaultRunOptions)
	}

	bad := []struct {
		body any
		path string
	}{
		{map[string]any{"artifact_retention_days": 0}, "artifact_retention_days"},
		{map[string]any{"artifact_retention_days": 366}, "artifact_retention_days"},
		{map[string]any{"name": " "}, "name"},
		{map[string]any{"default_run_options": map[string]any{"retries": 5}}, "default_run_options.retries"},
		{map[string]any{"default_run_options": map[string]any{"browser": "ie"}}, "default_run_options.browser"},
		{map[string]any{"default_run_options": map[string]any{"step_timeout_ms": "fast"}}, "default_run_options.step_timeout_ms"},
	}
	for _, c := range bad {
		r := m.expect("PATCH", "/api/v1/projects/SHOP", c.body, 400, nil)
		var body apiErr
		r.decode(t, &body)
		if len(body.Error.Details) == 0 || body.Error.Details[0].Path != c.path {
			t.Fatalf("%v: %s", c.body, r.body)
		}
	}
	m.expect("GET", "/api/v1/projects/SHOP", nil, 200, &p)
	if p.ArtifactRetentionDays != 90 || !p.DefaultRunOptions.Equal(want) {
		t.Fatal("rejected patches must not change the project")
	}

	m.expect("POST", "/api/v1/projects/SHOP/archive", nil, 200, &p)
	if p.ArchivedAt == nil {
		t.Fatal("archived_at not set")
	}
	var me auth.Me
	m.expect("GET", "/api/v1/me", nil, 200, &me)
	if len(me.Projects) != 0 {
		t.Fatalf("archived project still in /me: %+v", me.Projects)
	}
	var list projectList
	m.expect("GET", "/api/v1/projects", nil, 200, &list)
	if len(list.Data) != 0 {
		t.Fatal("archived project listed without include_archived")
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action IN ('project.update', 'project.archive')`, shop); n != 3 {
		t.Fatalf("audit rows: %d", n)
	}
}

func TestProjectMembers(t *testing.T) {
	e := newEnv(t)
	mara := e.createUser("mara@x.io", "Mara", "member", "active", testPassword)
	eddy := e.createUser("eddy@x.io", "Eddy", "member", "active", testPassword)
	val := e.createUser("val@x.io", "Val", "member", "active", testPassword)
	e.createUser("ivan@x.io", "Ivan", "member", "invited", "")
	dan := e.createUser("dan@x.io", "Dan", "member", "disabled", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, mara, "maintainer")
	e.addMember(shop, eddy, "editor")
	m, ed := e.browser(), e.browser()
	m.login("mara@x.io", testPassword)
	ed.login("eddy@x.io", testPassword)

	var members struct {
		Data []projects.Member `json:"data"`
	}
	ed.expect("GET", "/api/v1/projects/SHOP/members", nil, 200, &members)
	if len(members.Data) != 2 || members.Data[0].User.Name != "Mara" || members.Data[0].Role != "maintainer" {
		t.Fatalf("members: %+v", members.Data)
	}
	ed.expect("GET", "/api/v1/projects/SHOP/assignable-users", nil, 403, nil)
	ed.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": val, "role": "viewer"}, 403, nil)

	var assignable struct {
		Data []auth.UserRef `json:"data"`
	}
	m.expect("GET", "/api/v1/projects/SHOP/assignable-users", nil, 200, &assignable)
	if len(assignable.Data) != 1 || assignable.Data[0].ID != val.String() {
		t.Fatalf("assignable (active non-members only): %+v", assignable.Data)
	}

	var added projects.Member
	m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": val, "role": "viewer"}, 201, &added)
	if added.User.ID != val.String() || added.Role != "viewer" {
		t.Fatalf("added: %+v", added)
	}
	if r := m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": val, "role": "editor"}, 409, nil); r.errCode(t) != "conflict" {
		t.Fatal("duplicate member must be 409")
	}
	m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": val, "role": "owner"}, 400, nil)
	m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": uuid.NewString(), "role": "viewer"}, 400, nil)
	m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": "nope", "role": "viewer"}, 400, nil)
	m.expect("POST", "/api/v1/projects/SHOP/members", map[string]any{"user_id": dan, "role": "viewer"}, 400, nil)

	// Last maintainer rule.
	r := m.expect("PATCH", "/api/v1/projects/SHOP/members/"+mara.String(), map[string]any{"role": "editor"}, 400, nil)
	var body apiErr
	r.decode(t, &body)
	if body.Error.Code != "validation_failed" || body.Error.Message != "A project needs at least one maintainer" {
		t.Fatalf("demote last maintainer: %s", r.body)
	}
	m.expect("DELETE", "/api/v1/projects/SHOP/members/"+mara.String(), nil, 400, nil)

	var upd projects.Member
	m.expect("PATCH", "/api/v1/projects/SHOP/members/"+eddy.String(), map[string]any{"role": "maintainer"}, 200, &upd)
	if upd.Role != "maintainer" {
		t.Fatalf("promote: %+v", upd)
	}
	m.expect("PATCH", "/api/v1/projects/SHOP/members/"+mara.String(), map[string]any{"role": "editor"}, 200, nil) // two maintainers now
	m.expect("PATCH", "/api/v1/projects/SHOP/members/"+val.String(), nil, 403, nil)                               // Mara is editor now
	ed.expect("DELETE", "/api/v1/projects/SHOP/members/"+eddy.String(), nil, 400, nil)                            // Eddy is the last maintainer
	ed.expect("PATCH", "/api/v1/projects/SHOP/members/"+val.String(), map[string]any{"role": "bogus"}, 400, nil)
	ed.expect("PATCH", "/api/v1/projects/SHOP/members/not-a-uuid", map[string]any{"role": "viewer"}, 404, nil)
	ed.expect("DELETE", "/api/v1/projects/SHOP/members/"+dan.String(), nil, 404, nil)
	ed.expect("DELETE", "/api/v1/projects/SHOP/members/"+val.String(), nil, 204, nil)

	if n := e.count(`SELECT count(*) FROM project_members WHERE project_id = $1`, shop); n != 2 {
		t.Fatalf("members left: %d", n)
	}
	if n := e.count(`SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action LIKE 'member.%'`, shop); n != 4 {
		t.Fatalf("member audit rows: %d", n) // add val, promote eddy, demote mara, remove val
	}
}

// ------------------------------------------------------------------ stats

// pjTestCase inserts a test case (stats fixtures).
func (e *testEnv) pjTestCase(projectID uuid.UUID, seq int, title string) uuid.UUID {
	e.t.Helper()
	id := db.NewID()
	if _, err := e.pool.Exec(e.ctx, `INSERT INTO test_cases (id, project_id, seq, title) VALUES ($1, $2, $3, $4)`, id, projectID, seq, title); err != nil {
		e.t.Fatal(err)
	}
	return id
}

type pjCase struct {
	tc     uuid.UUID
	key    string
	status string
}

// pjRun inserts a finished-or-not run of the first case's test case directly in SQL.
func (e *testEnv) pjRun(projectID, userID uuid.UUID, seq int, status string, queued time.Time, duration time.Duration, cases ...pjCase) {
	e.t.Helper()
	id := db.NewID()
	var started, finished *time.Time
	if duration > 0 {
		s, f := queued.Add(time.Second), queued.Add(time.Second+duration)
		started, finished = &s, &f
	}
	_, err := e.pool.Exec(e.ctx, `
		INSERT INTO runs (id, project_id, seq, kind, test_case_id, target_key, target_title, status, triggered_by, options, queued_at, started_at, finished_at)
		VALUES ($1, $2, $3, 'test_case', $4, $5, 'T', $6, $7, '{}', $8, $9, $10)`,
		id, projectID, seq, cases[0].tc, cases[0].key, status, userID, queued, started, finished)
	if err != nil {
		e.t.Fatal(err)
	}
	for i, c := range cases {
		if _, err := e.pool.Exec(e.ctx, `
			INSERT INTO run_cases (id, run_id, position, test_case_id, test_case_key, test_case_revision, title, execution, status)
			VALUES ($1, $2, $3, $4, $5, 1, $6, 'automated', $7)`, db.NewID(), id, i+1, c.tc, c.key, "Title "+c.key, c.status); err != nil {
			e.t.Fatal(err)
		}
	}
}

func TestProjectStats(t *testing.T) {
	t.Setenv("QATLAS_TZ", "UTC")
	e := newEnv(t)
	uid := e.createUser("eddy@x.io", "Eddy", "member", "active", testPassword)
	shop := e.createProject("SHOP", "Shop", false)
	e.addMember(shop, uid, "viewer")
	t1, t2 := e.pjTestCase(shop, 1, "Login"), e.pjTestCase(shop, 2, "Checkout")
	now := time.Now()
	c := func(tc uuid.UUID, key, status string) pjCase { return pjCase{tc, key, status} }
	e.pjRun(shop, uid, 1, "passed", now.Add(-1*time.Hour), time.Second, c(t1, "SHOP-T1", "passed"))
	e.pjRun(shop, uid, 2, "failed", now.Add(-2*time.Hour), 3*time.Second, c(t1, "SHOP-T1", "failed"), c(t2, "SHOP-T2", "error"))
	e.pjRun(shop, uid, 3, "cancelled", now.Add(-3*time.Hour), 9*time.Second, c(t2, "SHOP-T2", "failed"))
	e.pjRun(shop, uid, 4, "awaiting_manual", now.Add(-30*time.Minute), 0, c(t2, "SHOP-T2", "pending"))
	e.pjRun(shop, uid, 5, "passed", now.Add(-10*24*time.Hour), time.Second, c(t1, "SHOP-T1", "passed"))

	v := e.browser()
	v.login("eddy@x.io", testPassword)
	var st projects.Stats
	v.expect("GET", "/api/v1/projects/SHOP/stats", nil, 200, &st)
	if st.Range != "7d" || st.TotalRuns != 4 || st.AwaitingManual != 1 || st.PassRate == nil || *st.PassRate != 0.5 ||
		st.AvgDurationMS == nil || *st.AvgDurationMS != 2000 || len(st.Daily) != 7 {
		t.Fatalf("7d stats: %+v", st)
	}
	if st.Daily[6].Date != now.UTC().Format(time.DateOnly) {
		t.Fatalf("last bucket %s, want today", st.Daily[6].Date)
	}
	var passed, failed, other int
	for _, d := range st.Daily {
		passed, failed, other = passed+d.Passed, failed+d.Failed, other+d.Other
	}
	if passed != 1 || failed != 1 || other != 2 {
		t.Fatalf("daily sums p=%d f=%d o=%d", passed, failed, other)
	}
	if len(st.TopFailing) != 2 ||
		st.TopFailing[0] != (projects.FailingCase{TestCaseKey: "SHOP-T2", Title: "Title SHOP-T2", Failures: 2, Runs: 3}) ||
		st.TopFailing[1] != (projects.FailingCase{TestCaseKey: "SHOP-T1", Title: "Title SHOP-T1", Failures: 1, Runs: 2}) {
		t.Fatalf("top failing: %+v", st.TopFailing)
	}

	v.expect("GET", "/api/v1/projects/SHOP/stats?range=30d", nil, 200, &st)
	if st.Range != "30d" || st.TotalRuns != 5 || len(st.Daily) != 30 || *st.PassRate != 2.0/3.0 {
		t.Fatalf("30d stats: %+v", st)
	}
	v.expect("GET", "/api/v1/projects/SHOP/stats?range=bogus", nil, 200, &st)
	if st.Range != "7d" {
		t.Fatalf("unknown range: %s", st.Range)
	}

	// Raw shape: nullable fields present and lists non-null on an empty project.
	empty := e.createProject("EMPTY", "Empty", false)
	e.addMember(empty, uid, "viewer")
	raw := v.expect("GET", "/api/v1/projects/EMPTY/stats", nil, 200, nil)
	var shape map[string]json.RawMessage
	raw.decode(t, &shape)
	if string(shape["pass_rate"]) != "null" || string(shape["avg_duration_ms"]) != "null" || string(shape["top_failing"]) != "[]" {
		t.Fatalf("empty stats: %s", raw.body)
	}

	// Project summary derives from the same runs.
	var list projectList
	v.expect("GET", "/api/v1/projects", nil, 200, &list)
	s := list.Data[0]
	if s.Key != "SHOP" || s.TestCaseCount != 2 || s.FlowCount != 0 || s.PassRate7d == nil || *s.PassRate7d != 0.5 ||
		s.LastRun == nil || s.LastRun.Key != "SHOP-R4" || s.LastRun.Status != "awaiting_manual" {
		t.Fatalf("summary: %+v", s)
	}
	if e2 := list.Data[1]; e2.Key != "EMPTY" || e2.LastRun != nil || e2.PassRate7d != nil {
		t.Fatalf("empty summary: %+v", e2)
	}
}
