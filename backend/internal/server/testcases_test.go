package server

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/testcases"
)

// ------------------------------------------------------------------ fixtures (tc* prefix)

type tcFixture struct {
	e        *testEnv
	shop     uuid.UUID
	editor   *client
	viewer   *client
	stranger *client
	editorID uuid.UUID
}

// tcSetup creates project SHOP with an editor and a viewer (plus PAY, where
// only the "stranger" is a member) and logs them in.
func tcSetup(t *testing.T) *tcFixture {
	t.Helper()
	e := newEnv(t)
	f := &tcFixture{e: e}
	f.editorID = e.createUser("ed@example.com", "Ed", "member", "active", testPassword)
	viewerID := e.createUser("vi@example.com", "Vi", "member", "active", testPassword)
	strangerID := e.createUser("st@example.com", "St", "member", "active", testPassword)
	f.shop = e.createProject("SHOP", "Shop", false)
	pay := e.createProject("PAY", "Pay", false)
	e.addMember(f.shop, f.editorID, "editor")
	e.addMember(f.shop, viewerID, "viewer")
	e.addMember(pay, f.editorID, "editor")
	e.addMember(pay, strangerID, "editor")
	f.editor, f.viewer, f.stranger = e.browser(), e.browser(), e.browser()
	f.editor.login("ed@example.com", testPassword)
	f.viewer.login("vi@example.com", testPassword)
	f.stranger.login("st@example.com", testPassword)
	return f
}

func tcStep(id, action string, kv ...any) map[string]any {
	s := map[string]any{"id": id, "action": action}
	for i := 0; i+1 < len(kv); i += 2 {
		s[kv[i].(string)] = kv[i+1]
	}
	return s
}

func (f *tcFixture) create(project string, body map[string]any) testcases.TestCase {
	f.e.t.Helper()
	var tc testcases.TestCase
	f.editor.expect("POST", "/api/v1/projects/"+project+"/test-cases", body, 201, &tc)
	return tc
}

func (f *tcFixture) createSimple(title string, extra ...any) testcases.TestCase {
	f.e.t.Helper()
	body := map[string]any{"title": title, "steps": []any{tcStep("s1", "goto", "url", "/")}}
	for i := 0; i+1 < len(extra); i += 2 {
		body[extra[i].(string)] = extra[i+1]
	}
	return f.create("SHOP", body)
}

func (f *tcFixture) folder(name string, parent *uuid.UUID) testcases.Folder {
	f.e.t.Helper()
	body := map[string]any{"name": name}
	if parent != nil {
		body["parent_id"] = parent.String()
	}
	var fo testcases.Folder
	f.editor.expect("POST", "/api/v1/projects/SHOP/folders", body, 201, &fo)
	return fo
}

type tcErrBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details []struct {
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"details"`
	} `json:"error"`
}

func tcErr(t *testing.T, r response) tcErrBody {
	t.Helper()
	var b tcErrBody
	r.decode(t, &b)
	return b
}

func (b tcErrBody) paths() []string {
	out := []string{}
	for _, d := range b.Error.Details {
		out = append(out, d.Path)
	}
	return out
}

func (b tcErrBody) has(path string) bool { return slices.Contains(b.paths(), path) }

type tcPage struct {
	Data       []testcases.Summary `json:"data"`
	NextCursor *string             `json:"next_cursor"`
}

func (f *tcFixture) listKeys(query string) []string {
	f.e.t.Helper()
	var p tcPage
	f.editor.expect("GET", "/api/v1/projects/SHOP/test-cases"+query, nil, 200, &p)
	keys := []string{}
	for _, s := range p.Data {
		keys = append(keys, s.Key)
	}
	return keys
}

// ------------------------------------------------------------------ tests

func TestTestCaseCreateAndValidate(t *testing.T) {
	f := tcSetup(t)
	c := f.editor

	// 422 with detail paths: title, duplicate step id, missing param, manual in automated.
	r := c.expect("POST", "/api/v1/projects/SHOP/test-cases", map[string]any{
		"title": "  ",
		"steps": []any{
			tcStep("a", "click"),
			tcStep("a", "goto", "url", "/"),
			tcStep("b", "manual", "description", "Look"),
			map[string]any{"action": "goto", "url": "/"},
		},
	}, 422, nil)
	eb := tcErr(t, r)
	if eb.Error.Code != "validation_failed" {
		t.Fatalf("code %q", eb.Error.Code)
	}
	for _, p := range []string{"title", "steps[0].selector", "steps[1].id", "steps[2].action", "steps[3].id"} {
		if !eb.has(p) {
			t.Errorf("missing detail %s in %v", p, eb.paths())
		}
	}
	// Enum and folder checks (the DB would otherwise 500).
	eb = tcErr(t, c.expect("POST", "/api/v1/projects/SHOP/test-cases", map[string]any{"title": "x", "priority": "urgent", "folder_id": "nope", "steps": []any{}}, 422, nil))
	if !eb.has("priority") || !eb.has("folder_id") {
		t.Fatalf("enum/folder details: %v", eb.paths())
	}
	eb = tcErr(t, c.expect("POST", "/api/v1/projects/SHOP/test-cases", map[string]any{"title": "x", "folder_id": uuid.NewString(), "steps": []any{}}, 422, nil))
	if !eb.has("folder_id") {
		t.Fatalf("unknown folder: %v", eb.paths())
	}
	eb = tcErr(t, c.expect("POST", "/api/v1/projects/SHOP/test-cases", map[string]any{"title": "x", "steps": []any{"goto"}}, 422, nil))
	if !eb.has("steps[0]") {
		t.Fatalf("non-object step: %v", eb.paths())
	}
	if n := f.e.count(`SELECT seq_case FROM projects WHERE id = $1`, f.shop); n != 0 {
		t.Fatalf("failed creates must not consume keys: seq_case=%d", n)
	}

	// Valid create: defaults, key, unknown step fields preserved, revision 1 "Created".
	tc := f.create("SHOP", map[string]any{
		"title": "  Login works  ",
		"tags":  []string{"smoke", "auth"},
		"steps": []any{tcStep("s1", "goto", "url", "/login", "x_custom", map[string]any{"keep": []int{1, 2}}), tcStep("s2", "wait", "ms", 500)},
	})
	if tc.Key != "SHOP-T1" || tc.ProjectKey != "SHOP" || tc.Title != "Login works" || tc.Priority != "medium" || tc.Status != "draft" ||
		tc.Execution != "automated" || tc.Revision != 1 || tc.StepCount != 2 || tc.FolderID != nil || tc.LastRunStatus != nil ||
		tc.CreatedBy.ID != f.editorID.String() || tc.UpdatedBy.Name != "Ed" {
		t.Fatalf("created: %+v", tc)
	}
	var steps []map[string]any
	_ = json.Unmarshal(tc.Steps, &steps)
	if keep, ok := steps[0]["x_custom"].(map[string]any); !ok || fmt.Sprint(keep["keep"]) != "[1 2]" {
		t.Fatalf("unknown step field lost: %s", tc.Steps)
	}
	if string(tc.Variables) != "{}" {
		t.Fatalf("variables: %s", tc.Variables)
	}
	// Raw shape: required nullable fields are present.
	raw := c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, nil)
	var shape map[string]any
	_ = json.Unmarshal(raw.body, &shape)
	for _, k := range []string{"id", "key", "folder_id", "title", "priority", "status", "execution", "tags", "step_count", "revision",
		"last_run_status", "last_run_at", "updated_at", "updated_by", "project_key", "description", "preconditions", "variables", "steps", "created_at", "created_by"} {
		if _, ok := shape[k]; !ok {
			t.Errorf("TestCase.%s missing", k)
		}
	}
	var revs struct{ Data []testcases.RevisionSummary }
	c.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions", nil, 200, &revs)
	if len(revs.Data) != 1 || revs.Data[0].Revision != 1 || revs.Data[0].ChangeNote != "Created" || revs.Data[0].Author.ID != f.editorID.String() {
		t.Fatalf("revisions: %+v", revs.Data)
	}
	if tc2 := f.createSimple("Second"); tc2.Key != "SHOP-T2" {
		t.Fatalf("second key %s", tc2.Key)
	}

	// Validate endpoint: viewer allowed (view), errors + warnings, nothing saved.
	var v testcases.ValidationResult
	f.viewer.expect("POST", "/api/v1/projects/SHOP/test-cases/validate", map[string]any{
		"title": "x", "steps": []any{tcStep("w", "wait", "ms", 100), tcStep("e", "expect_status", "value", 200)},
	}, 200, &v)
	if v.Valid || len(v.Errors) != 1 || v.Errors[0].Path != "steps[1].action" || len(v.Warnings) != 1 || v.Warnings[0].Path != "steps[0].action" {
		t.Fatalf("validate: %+v", v)
	}
	f.viewer.expect("POST", "/api/v1/projects/SHOP/test-cases/validate", map[string]any{"title": "x", "steps": []any{}}, 200, &v)
	if !v.Valid || len(v.Errors) != 0 || len(v.Warnings) != 1 || v.Warnings[0].Path != "steps" {
		t.Fatalf("validate empty: %+v", v)
	}

	// Exact key lookup, 404s.
	c.expect("GET", "/api/v1/test-cases/SHOP-T01", nil, 404, nil)
	c.expect("GET", "/api/v1/test-cases/SHOP-T99", nil, 404, nil)
	c.expect("GET", "/api/v1/test-cases/NOPE-T1", nil, 404, nil)

	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action = 'test_case.create' AND project_id = $1`, f.shop); n != 2 {
		t.Fatalf("create audit rows: %d", n)
	}
}

func TestTestCaseUpdateRevisions(t *testing.T) {
	f := tcSetup(t)
	c := f.editor
	f.createSimple("Original", "tags", []string{"a"})
	folder := f.folder("Checkout", nil)

	var tc testcases.TestCase
	c.expect("PATCH", "/api/v1/test-cases/SHOP-T1", map[string]any{
		"revision": 1, "title": "Renamed", "folder_id": folder.ID.String(), "change_note": "  Rename  ",
	}, 200, &tc)
	if tc.Revision != 2 || tc.Title != "Renamed" || tc.FolderID == nil || *tc.FolderID != folder.ID || strings.Join(tc.Tags, ",") != "a" || tc.StepCount != 1 {
		t.Fatalf("patched: %+v", tc)
	}

	// Stale or missing revision → 409 revision_conflict.
	for _, body := range []map[string]any{{"revision": 1, "title": "Stale"}, {"title": "No revision"}} {
		if r := c.expect("PATCH", "/api/v1/test-cases/SHOP-T1", body, 409, nil); r.errCode(t) != "revision_conflict" {
			t.Fatalf("conflict code: %s", r.body)
		}
	}

	// Merged validation: switching to manual makes the existing goto step invalid.
	eb := tcErr(t, c.expect("PATCH", "/api/v1/test-cases/SHOP-T1", map[string]any{"revision": 2, "execution": "manual"}, 422, nil))
	if !eb.has("steps[0].action") {
		t.Fatalf("merged validation: %v", eb.paths())
	}
	// folder_id null moves to root; no change note → "No change note".
	c.expect("PATCH", "/api/v1/test-cases/SHOP-T1", map[string]any{"revision": 2, "folder_id": nil}, 200, &tc)
	if tc.Revision != 3 || tc.FolderID != nil || tc.Title != "Renamed" {
		t.Fatalf("second patch: %+v", tc)
	}

	var revs struct{ Data []testcases.RevisionSummary }
	c.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions", nil, 200, &revs)
	if len(revs.Data) != 3 || revs.Data[0].Revision != 3 || revs.Data[0].ChangeNote != "No change note" || revs.Data[1].ChangeNote != "Rename" {
		t.Fatalf("revisions: %+v", revs.Data)
	}
	var rev struct {
		testcases.RevisionSummary
		Snapshot map[string]any `json:"snapshot"`
	}
	f.viewer.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions/1", nil, 200, &rev)
	if rev.Revision != 1 || rev.Snapshot["title"] != "Original" || rev.Snapshot["folder_id"] != nil || len(rev.Snapshot["steps"].([]any)) != 1 {
		t.Fatalf("revision 1: %+v", rev)
	}
	f.viewer.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions/2", nil, 200, &rev)
	if rev.Snapshot["title"] != "Renamed" || rev.Snapshot["folder_id"] != folder.ID.String() {
		t.Fatalf("revision 2: %+v", rev)
	}
	c.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions/9", nil, 404, nil)
	c.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions/abc", nil, 404, nil)
	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action = 'test_case.update'`); n != 2 {
		t.Fatalf("update audit rows: %d", n)
	}
}

func TestTestCaseDuplicate(t *testing.T) {
	f := tcSetup(t)
	src := f.createSimple("Checkout", "status", "ready", "priority", "high", "tags", []string{"x"}, "variables", map[string]string{"qty": "2"})
	var dup testcases.TestCase
	f.editor.expect("POST", "/api/v1/test-cases/SHOP-T1/duplicate", nil, 201, &dup)
	if dup.Key != "SHOP-T2" || dup.ID == src.ID || dup.Title != "Checkout (copy)" || dup.Status != "draft" || dup.Priority != "high" ||
		dup.Revision != 1 || strings.Join(dup.Tags, ",") != "x" || string(dup.Variables) != string(src.Variables) || dup.StepCount != 1 {
		t.Fatalf("duplicate: %+v", dup)
	}
	var revs struct{ Data []testcases.RevisionSummary }
	f.editor.expect("GET", "/api/v1/test-cases/SHOP-T2/revisions", nil, 200, &revs)
	if len(revs.Data) != 1 || revs.Data[0].ChangeNote != "Duplicated from SHOP-T1" {
		t.Fatalf("duplicate revisions: %+v", revs.Data)
	}
	f.viewer.expect("POST", "/api/v1/test-cases/SHOP-T1/duplicate", nil, 403, nil)
}

func TestTestCaseBulkAndTags(t *testing.T) {
	f := tcSetup(t)
	c := f.editor
	t1 := f.createSimple("One", "tags", []string{"a", "b"})
	t2 := f.createSimple("Two", "tags", []string{"b"})
	t3 := f.createSimple("Three")
	other := f.create("PAY", map[string]any{"title": "Pay case", "steps": []any{}})
	folder := f.folder("Cart", nil)

	bulk := func(body map[string]any, want int) {
		t.Helper()
		var res testcases.BulkResult
		c.expect("POST", "/api/v1/projects/SHOP/test-cases/bulk", body, 200, &res)
		if res.Updated != want {
			t.Fatalf("bulk %v: updated %d, want %d", body["action"], res.Updated, want)
		}
	}
	ids := func(tcs ...testcases.TestCase) []string {
		out := []string{}
		for _, tc := range tcs {
			out = append(out, tc.ID.String())
		}
		return out
	}

	// Foreign-project and malformed ids are ignored.
	bulk(map[string]any{"action": "move", "ids": append(ids(t1, t2, other), "junk"), "folder_id": folder.ID.String()}, 2)
	if got := strings.Join(f.listKeys("?folder="+folder.ID.String()), ","); got != "SHOP-T1,SHOP-T2" {
		t.Fatalf("moved: %s", got)
	}
	var pay testcases.TestCase
	c.expect("GET", "/api/v1/test-cases/PAY-T1", nil, 200, &pay)
	if pay.FolderID != nil {
		t.Fatal("foreign test case moved")
	}
	bulk(map[string]any{"action": "move", "ids": ids(t2)}, 1) // absent folder_id = root
	if got := strings.Join(f.listKeys("?folder=root"), ","); got != "SHOP-T2,SHOP-T3" {
		t.Fatalf("root: %s", got)
	}

	bulk(map[string]any{"action": "add_tags", "ids": ids(t1, t2), "tags": []string{"smoke", "a"}}, 2)
	bulk(map[string]any{"action": "remove_tags", "ids": ids(t1), "tags": []string{"b"}}, 1)
	var got testcases.TestCase
	c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, &got)
	if strings.Join(got.Tags, ",") != "a,smoke" || got.Revision != 1 {
		t.Fatalf("t1 tags: %v rev %d", got.Tags, got.Revision)
	}
	c.expect("GET", "/api/v1/test-cases/SHOP-T2", nil, 200, &got)
	if strings.Join(got.Tags, ",") != "b,smoke,a" {
		t.Fatalf("t2 tags: %v", got.Tags)
	}
	if k := strings.Join(f.listKeys("?tags=smoke,a"), ","); k != "SHOP-T1,SHOP-T2" {
		t.Fatalf("tags filter: %s", k)
	}

	bulk(map[string]any{"action": "set_status", "ids": ids(t1, t3), "status": "ready"}, 2)
	if k := strings.Join(f.listKeys("?status=ready"), ","); k != "SHOP-T1,SHOP-T3" {
		t.Fatalf("status filter: %s", k)
	}

	var tags struct{ Data []testcases.TagCount }
	f.viewer.expect("GET", "/api/v1/projects/SHOP/tags", nil, 200, &tags)
	if fmt.Sprint(tags.Data) != "[{a 2} {b 1} {smoke 2}]" {
		t.Fatalf("tags: %v", tags.Data)
	}

	bulk(map[string]any{"action": "delete", "ids": ids(t1, t3)}, 2)
	bulk(map[string]any{"action": "delete", "ids": ids(t1)}, 0) // already deleted
	if k := strings.Join(f.listKeys(""), ","); k != "SHOP-T2" {
		t.Fatalf("after delete: %s", k)
	}
	c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 404, nil)
	f.viewer.expect("GET", "/api/v1/projects/SHOP/tags", nil, 200, &tags)
	if fmt.Sprint(tags.Data) != "[{a 1} {b 1} {smoke 1}]" {
		t.Fatalf("tags after delete: %v", tags.Data)
	}

	// Rule errors.
	c.expect("POST", "/api/v1/projects/SHOP/test-cases/bulk", map[string]any{"action": "explode", "ids": ids(t2)}, 400, nil)
	c.expect("POST", "/api/v1/projects/SHOP/test-cases/bulk", map[string]any{"action": "delete", "ids": []string{}}, 400, nil)
	c.expect("POST", "/api/v1/projects/SHOP/test-cases/bulk", map[string]any{"action": "set_status", "ids": ids(t2), "status": "bogus"}, 400, nil)
	c.expect("POST", "/api/v1/projects/SHOP/test-cases/bulk", map[string]any{"action": "move", "ids": ids(t2), "folder_id": uuid.NewString()}, 400, nil)
	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action = 'test_case.bulk'`); n != 7 {
		t.Fatalf("bulk audit rows: %d", n)
	}
}

func TestTestCaseListFilters(t *testing.T) {
	f := tcSetup(t)
	f.createSimple("Login happy path", "priority", "high")
	f.create("SHOP", map[string]any{"title": "Manual review", "execution": "manual", "steps": []any{tcStep("m", "manual", "description", "Check")}})
	for i := 3; i <= 11; i++ {
		f.createSimple(fmt.Sprintf("Case %d", i))
	}
	if k := strings.Join(f.listKeys("?q=LOGIN"), ","); k != "SHOP-T1" {
		t.Fatalf("q title: %s", k)
	}
	if k := strings.Join(f.listKeys("?q=shop-t1"), ","); k != "SHOP-T1,SHOP-T10,SHOP-T11" {
		t.Fatalf("q key: %s", k)
	}
	if k := strings.Join(f.listKeys("?execution=manual"), ","); k != "SHOP-T2" {
		t.Fatalf("execution: %s", k)
	}
	if k := strings.Join(f.listKeys("?priority=high"), ","); k != "SHOP-T1" {
		t.Fatalf("priority: %s", k)
	}
	if k := f.listKeys("?folder=not-a-uuid"); len(k) != 0 {
		t.Fatalf("bad folder: %v", k)
	}
	// Ordered by key number (T10 after T9), paginated.
	var p tcPage
	f.viewer.expect("GET", "/api/v1/projects/SHOP/test-cases?limit=5&cursor=5", nil, 200, &p)
	if len(p.Data) != 5 || p.Data[0].Key != "SHOP-T6" || p.Data[4].Key != "SHOP-T10" || p.NextCursor == nil || *p.NextCursor != "10" {
		t.Fatalf("page: %+v next=%v", p.Data, p.NextCursor)
	}
	f.viewer.expect("GET", "/api/v1/projects/SHOP/test-cases?limit=5&cursor=10", nil, 200, &p)
	if len(p.Data) != 1 || p.NextCursor != nil {
		t.Fatalf("last page: %+v", p)
	}

	// last_run_status: fallback from runs while the denormalised column is NULL.
	var t1 uuid.UUID
	if err := f.e.pool.QueryRow(f.e.ctx, `SELECT id FROM test_cases WHERE seq = 1`).Scan(&t1); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	for i, st := range []string{"passed", "failed"} {
		_, err := f.e.pool.Exec(f.e.ctx, `
			INSERT INTO runs (id, project_id, seq, kind, test_case_id, target_key, target_title, status, triggered_by, options, queued_at)
			VALUES ($1, $2, $3, 'test_case', $4, 'SHOP-T1', 'Login', $5, $6, '{}', $7)`,
			db.NewID(), f.shop, i+1, t1, st, f.editorID, now.Add(time.Duration(i)*time.Minute))
		if err != nil {
			t.Fatal(err)
		}
	}
	f.viewer.expect("GET", "/api/v1/projects/SHOP/test-cases?last_run_status=failed", nil, 200, &p)
	if len(p.Data) != 1 || p.Data[0].Key != "SHOP-T1" || *p.Data[0].LastRunStatus != "failed" || !p.Data[0].LastRunAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("fallback last run: %+v", p.Data)
	}
	// The denormalised column (maintained by the worker) wins once set.
	if _, err := f.e.pool.Exec(f.e.ctx, `UPDATE test_cases SET last_run_status = 'passed', last_run_at = $2 WHERE id = $1`, t1, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if k := f.listKeys("?last_run_status=failed"); len(k) != 0 {
		t.Fatalf("denormalised column ignored: %v", k)
	}
	var tc testcases.TestCase
	f.viewer.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, &tc)
	if *tc.LastRunStatus != "passed" || !tc.LastRunAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("denormalised: %v %v", *tc.LastRunStatus, tc.LastRunAt)
	}
}

func TestFolders(t *testing.T) {
	f := tcSetup(t)
	c := f.editor
	root := f.folder("Root", nil)
	a := f.folder("A", &root.ID)
	b := f.folder("B", &a.ID)
	second := f.folder("Second", &root.ID)
	if a.Position != 0 || second.Position != 1 || b.ParentID == nil || *b.ParentID != a.ID {
		t.Fatalf("positions/parents: a=%+v second=%+v b=%+v", a, second, b)
	}
	f.createSimple("In A", "folder_id", a.ID.String())
	f.createSimple("In B", "folder_id", b.ID.String())
	f.createSimple("At root")

	// Descendants included; root = no folder.
	if k := strings.Join(f.listKeys("?folder="+root.ID.String()), ","); k != "SHOP-T1,SHOP-T2" {
		t.Fatalf("descendants: %s", k)
	}
	if k := strings.Join(f.listKeys("?folder=root"), ","); k != "SHOP-T3" {
		t.Fatalf("root: %s", k)
	}

	// Validation and cycles.
	c.expect("POST", "/api/v1/projects/SHOP/folders", map[string]any{"name": " "}, 400, nil)
	c.expect("POST", "/api/v1/projects/SHOP/folders", map[string]any{"name": "x", "parent_id": uuid.NewString()}, 400, nil)
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/"+a.ID.String(), map[string]any{"parent_id": b.ID.String()}, 400, nil)
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/"+a.ID.String(), map[string]any{"parent_id": a.ID.String()}, 400, nil)
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/"+uuid.NewString(), map[string]any{"name": "x"}, 404, nil)
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/junk", map[string]any{"name": "x"}, 404, nil)
	c.expect("PATCH", "/api/v1/projects/PAY/folders/"+a.ID.String(), map[string]any{"name": "x"}, 404, nil)

	var fo testcases.Folder
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/"+second.ID.String(), map[string]any{"name": "  ", "parent_id": nil, "position": 7}, 200, &fo)
	if fo.Name != "Second" || fo.ParentID != nil || fo.Position != 7 {
		t.Fatalf("patched folder: %+v", fo)
	}
	c.expect("PATCH", "/api/v1/projects/SHOP/folders/"+second.ID.String(), map[string]any{"name": "Renamed", "parent_id": b.ID.String()}, 200, &fo)
	if fo.Name != "Renamed" || fo.ParentID == nil || *fo.ParentID != b.ID {
		t.Fatalf("moved folder: %+v", fo)
	}

	// Delete A: B and A's test case move to Root.
	c.expect("DELETE", "/api/v1/projects/SHOP/folders/"+a.ID.String(), nil, 204, nil)
	var list struct{ Data []testcases.Folder }
	f.viewer.expect("GET", "/api/v1/projects/SHOP/folders", nil, 200, &list)
	byName := map[string]testcases.Folder{}
	for _, x := range list.Data {
		byName[x.Name] = x
	}
	if len(list.Data) != 3 || byName["B"].ParentID == nil || *byName["B"].ParentID != root.ID || byName["Root"].TestCaseCount != 1 || byName["B"].TestCaseCount != 1 {
		t.Fatalf("after delete: %+v", list.Data)
	}
	var tc testcases.TestCase
	c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, &tc)
	if tc.FolderID == nil || *tc.FolderID != root.ID {
		t.Fatalf("test case not re-parented: %v", tc.FolderID)
	}
	// Delete a top-level folder: children go to root (null).
	c.expect("DELETE", "/api/v1/projects/SHOP/folders/"+root.ID.String(), nil, 204, nil)
	f.viewer.expect("GET", "/api/v1/projects/SHOP/folders", nil, 200, &list)
	for _, x := range list.Data {
		if x.Name == "B" && x.ParentID != nil {
			t.Fatalf("B should be top-level: %+v", x)
		}
	}
	c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, &tc)
	if tc.FolderID != nil {
		t.Fatal("test case should be at root")
	}
	c.expect("DELETE", "/api/v1/projects/SHOP/folders/"+root.ID.String(), nil, 404, nil)
	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action LIKE 'folder.%'`); n != 8 {
		t.Fatalf("folder audit rows: %d", n) // 4 create + 2 update + 2 delete
	}
}

func TestTestCaseDeleteInUse(t *testing.T) {
	f := tcSetup(t)
	c := f.editor
	tc := f.createSimple("Used")
	var fl struct{ Key string }
	c.expect("POST", "/api/v1/projects/SHOP/flows", map[string]any{"name": "Flow", "items": []any{map[string]any{"test_case_id": tc.ID.String()}}}, 201, &fl)

	r := c.expect("DELETE", "/api/v1/test-cases/SHOP-T1", nil, 409, nil)
	if eb := tcErr(t, r); eb.Error.Code != "in_use" || !strings.Contains(eb.Error.Message, "SHOP-F1") {
		t.Fatalf("in_use: %s", r.body)
	}
	c.expect("DELETE", "/api/v1/flows/"+fl.Key, nil, 204, nil)
	c.expect("DELETE", "/api/v1/test-cases/SHOP-T1", nil, 204, nil)
	c.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 404, nil)
	c.expect("DELETE", "/api/v1/test-cases/SHOP-T1", nil, 404, nil)
	if n := f.e.count(`SELECT count(*) FROM test_cases WHERE deleted_at IS NOT NULL`); n != 1 {
		t.Fatalf("soft delete: %d", n)
	}
	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action = 'test_case.delete' AND entity_id = 'SHOP-T1'`); n != 1 {
		t.Fatalf("delete audit: %d", n)
	}
}

func TestTestCasePermissions(t *testing.T) {
	f := tcSetup(t)
	tc := f.createSimple("Case")
	folder := f.folder("F", nil)
	v := f.viewer

	// Reads are fine for viewers.
	v.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, nil)
	v.expect("GET", "/api/v1/projects/SHOP/test-cases", nil, 200, nil)
	v.expect("GET", "/api/v1/projects/SHOP/folders", nil, 200, nil)
	v.expect("GET", "/api/v1/test-cases/SHOP-T1/revisions", nil, 200, nil)
	v.expect("GET", "/api/v1/projects/SHOP/flows", nil, 200, nil)

	// Every mutation is 403 forbidden.
	body := map[string]any{"title": "x", "steps": []any{}}
	flowBody := map[string]any{"name": "x", "items": []any{map[string]any{"test_case_id": tc.ID.String()}}}
	for _, m := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/v1/projects/SHOP/test-cases", body},
		{"PATCH", "/api/v1/test-cases/SHOP-T1", map[string]any{"revision": 1, "title": "y"}},
		{"DELETE", "/api/v1/test-cases/SHOP-T1", nil},
		{"POST", "/api/v1/test-cases/SHOP-T1/duplicate", nil},
		{"POST", "/api/v1/projects/SHOP/test-cases/bulk", map[string]any{"action": "delete", "ids": []string{tc.ID.String()}}},
		{"POST", "/api/v1/projects/SHOP/folders", map[string]any{"name": "x"}},
		{"PATCH", "/api/v1/projects/SHOP/folders/" + folder.ID.String(), map[string]any{"name": "x"}},
		{"DELETE", "/api/v1/projects/SHOP/folders/" + folder.ID.String(), nil},
		{"POST", "/api/v1/projects/SHOP/flows", flowBody},
	} {
		if r := v.expect(m.method, m.path, m.body, 403, nil); r.errCode(t) != "forbidden" {
			t.Fatalf("%s %s: %s", m.method, m.path, r.body)
		}
	}

	// Non-members get 404, never 403.
	f.stranger.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 404, nil)
	f.stranger.expect("POST", "/api/v1/projects/SHOP/test-cases", body, 404, nil)
	f.stranger.expect("GET", "/api/v1/projects/SHOP/tags", nil, 404, nil)

	// A read-only API token can read but not write.
	var created auth.CreatedToken
	f.editor.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "ro", "scopes": []string{"read"}}, 201, &created)
	b := f.e.bearer(created.Secret)
	b.noCSRF = true
	b.expect("GET", "/api/v1/test-cases/SHOP-T1", nil, 200, nil)
	b.expect("POST", "/api/v1/projects/SHOP/test-cases/validate", body, 200, nil)
	b.expect("POST", "/api/v1/projects/SHOP/test-cases", body, 403, nil)

	if n := f.e.count(`SELECT count(*) FROM test_cases`); n != 1 {
		t.Fatalf("forbidden mutations changed data: %d test cases", n)
	}
}

func TestTestCaseKeySequencingConcurrent(t *testing.T) {
	f := tcSetup(t)
	const n = 8
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		keys []string
		errs []string
	)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := f.editor.do("POST", "/api/v1/projects/SHOP/test-cases", map[string]any{"title": fmt.Sprintf("Parallel %d", i), "steps": []any{}})
			mu.Lock()
			defer mu.Unlock()
			if r.status != 201 {
				errs = append(errs, fmt.Sprintf("%d %s", r.status, r.body))
				return
			}
			var tc testcases.TestCase
			if err := json.Unmarshal(r.body, &tc); err != nil {
				errs = append(errs, err.Error())
				return
			}
			keys = append(keys, tc.Key)
		}()
	}
	wg.Wait()
	if len(errs) > 0 {
		t.Fatalf("parallel creates failed: %v", errs)
	}
	sort.Slice(keys, func(i, j int) bool {
		return len(keys[i]) < len(keys[j]) || (len(keys[i]) == len(keys[j]) && keys[i] < keys[j])
	})
	want := []string{}
	for i := 1; i <= n; i++ {
		want = append(want, fmt.Sprintf("SHOP-T%d", i))
	}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("keys: %v", keys)
	}
}
