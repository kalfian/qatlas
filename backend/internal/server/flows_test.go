package server

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/flows"
)

func flItem(id uuid.UUID, extra ...any) map[string]any {
	m := map[string]any{"test_case_id": id.String()}
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i].(string)] = extra[i+1]
	}
	return m
}

func TestFlowsCRUDAndValidation(t *testing.T) {
	f := tcSetup(t)
	c := f.editor
	auto := f.createSimple("Login")
	manual := f.create("SHOP", map[string]any{"title": "Eyeball", "execution": "manual", "steps": []any{tcStep("m", "manual", "description", "Look")}})
	foreign := f.create("PAY", map[string]any{"title": "Pay", "steps": []any{}})
	gone := f.createSimple("Gone")
	c.expect("DELETE", "/api/v1/test-cases/"+gone.Key, nil, 204, nil)

	// 422 details: name, items, manual in shared session, unknown / foreign / deleted test cases.
	eb := tcErr(t, c.expect("POST", "/api/v1/projects/SHOP/flows", map[string]any{"name": " ", "items": []any{}}, 422, nil))
	if eb.Error.Code != "validation_failed" || !eb.has("name") || !eb.has("items") {
		t.Fatalf("empty flow: %v", eb.paths())
	}
	eb = tcErr(t, c.expect("POST", "/api/v1/projects/SHOP/flows", map[string]any{
		"name": "Shared", "shared_session": true,
		"items": []any{flItem(auto.ID), flItem(manual.ID), flItem(foreign.ID), flItem(gone.ID), map[string]any{"test_case_id": "junk"}},
	}, 422, nil))
	if strings.Join(eb.paths(), ",") != "items[1],items[2],items[3],items[4]" {
		t.Fatalf("item details: %v", eb.paths())
	}
	if !strings.Contains(eb.Error.Details[0].Message, "SHOP-T2") || eb.Error.Details[1].Message != "Test case not found" {
		t.Fatalf("item messages: %+v", eb.Error.Details)
	}
	if n := f.e.count(`SELECT seq_flow FROM projects WHERE id = $1`, f.shop); n != 0 {
		t.Fatalf("failed creates must not consume keys: %d", n)
	}

	// Valid create (manual allowed without shared session).
	var fl flows.Flow
	c.expect("POST", "/api/v1/projects/SHOP/flows", map[string]any{
		"name": "  Checkout  ", "tags": []string{"e2e"}, "variables": map[string]string{"qty": "1"},
		"items": []any{flItem(auto.ID, "continue_on_failure", true), flItem(manual.ID, "enabled", false)},
	}, 201, &fl)
	if fl.Key != "SHOP-F1" || fl.ProjectKey != "SHOP" || fl.Name != "Checkout" || fl.Revision != 1 || !fl.StopOnFailure || fl.SharedSession ||
		fl.ItemCount != 2 || !fl.HasManual || fl.LastRunStatus != nil || len(fl.Items) != 2 {
		t.Fatalf("created flow: %+v", fl)
	}
	it := fl.Items[0]
	if it.TestCase.Key != "SHOP-T1" || it.TestCase.Title != "Login" || it.TestCase.StepCount != 1 || it.TestCase.Execution != "automated" ||
		!it.ContinueOnFailure || !it.Enabled || fl.Items[1].Enabled || fl.Items[1].TestCase.Key != "SHOP-T2" {
		t.Fatalf("items: %+v", fl.Items)
	}
	var vars map[string]string
	_ = json.Unmarshal(fl.Variables, &vars)
	if vars["qty"] != "1" {
		t.Fatalf("variables: %s", fl.Variables)
	}
	raw := f.viewer.expect("GET", "/api/v1/flows/SHOP-F1", nil, 200, nil)
	var shape map[string]any
	_ = json.Unmarshal(raw.body, &shape)
	for _, k := range []string{"id", "key", "name", "description", "tags", "shared_session", "stop_on_failure", "item_count", "has_manual",
		"last_run_status", "last_run_at", "updated_at", "project_key", "variables", "items", "revision"} {
		if _, ok := shape[k]; !ok {
			t.Errorf("Flow.%s missing", k)
		}
	}

	// PATCH: revision conflict, shared-session check uses the effective value, items replaced.
	for _, body := range []map[string]any{
		{"revision": 7, "name": "x", "items": []any{flItem(auto.ID)}},
		{"name": "x", "items": []any{flItem(auto.ID)}},
	} {
		if r := c.expect("PATCH", "/api/v1/flows/SHOP-F1", body, 409, nil); r.errCode(t) != "revision_conflict" {
			t.Fatalf("flow conflict: %s", r.body)
		}
	}
	eb = tcErr(t, c.expect("PATCH", "/api/v1/flows/SHOP-F1", map[string]any{"revision": 1, "name": "x", "shared_session": true, "items": []any{flItem(manual.ID)}}, 422, nil))
	if strings.Join(eb.paths(), ",") != "items[0]" {
		t.Fatalf("patch shared/manual: %v", eb.paths())
	}
	c.expect("PATCH", "/api/v1/flows/SHOP-F1", map[string]any{"revision": 1, "name": "x"}, 422, nil) // items required
	c.expect("PATCH", "/api/v1/flows/SHOP-F1", map[string]any{
		"revision": 1, "name": "Checkout v2", "shared_session": true, "stop_on_failure": false, "items": []any{flItem(auto.ID), flItem(auto.ID)},
	}, 200, &fl)
	if fl.Revision != 2 || fl.Name != "Checkout v2" || !fl.SharedSession || fl.StopOnFailure || fl.ItemCount != 2 || fl.HasManual ||
		strings.Join(fl.Tags, ",") != "e2e" || fl.Items[1].TestCase.Key != "SHOP-T1" {
		t.Fatalf("patched flow: %+v", fl)
	}
	if n := f.e.count(`SELECT count(*) FROM flow_items`); n != 2 {
		t.Fatalf("items not replaced: %d", n)
	}
	// With shared_session already on, adding a manual case without restating it is still rejected.
	c.expect("PATCH", "/api/v1/flows/SHOP-F1", map[string]any{"revision": 2, "name": "x", "items": []any{flItem(manual.ID)}}, 422, nil)

	// List + q filter (name or key).
	c.expect("POST", "/api/v1/projects/SHOP/flows", map[string]any{"name": "Smoke", "items": []any{flItem(auto.ID)}}, 201, nil)
	var list struct{ Data []flows.Summary }
	f.viewer.expect("GET", "/api/v1/projects/SHOP/flows", nil, 200, &list)
	if len(list.Data) != 2 || list.Data[0].Key != "SHOP-F1" || list.Data[1].Key != "SHOP-F2" {
		t.Fatalf("flows: %+v", list.Data)
	}
	f.viewer.expect("GET", "/api/v1/projects/SHOP/flows?q=smo", nil, 200, &list)
	if len(list.Data) != 1 || list.Data[0].Key != "SHOP-F2" {
		t.Fatalf("q name: %+v", list.Data)
	}
	f.viewer.expect("GET", "/api/v1/projects/SHOP/flows?q=shop-f1", nil, 200, &list)
	if len(list.Data) != 1 || list.Data[0].Key != "SHOP-F1" {
		t.Fatalf("q key: %+v", list.Data)
	}

	// Viewer cannot mutate; delete is soft.
	f.viewer.expect("PATCH", "/api/v1/flows/SHOP-F1", map[string]any{"revision": 2, "name": "x", "items": []any{flItem(auto.ID)}}, 403, nil)
	f.viewer.expect("DELETE", "/api/v1/flows/SHOP-F1", nil, 403, nil)
	f.stranger.expect("GET", "/api/v1/flows/SHOP-F1", nil, 404, nil)
	c.expect("DELETE", "/api/v1/flows/SHOP-F1", nil, 204, nil)
	c.expect("GET", "/api/v1/flows/SHOP-F1", nil, 404, nil)
	c.expect("GET", "/api/v1/flows/SHOP-F01", nil, 404, nil)
	f.viewer.expect("GET", "/api/v1/projects/SHOP/flows", nil, 200, &list)
	if len(list.Data) != 1 {
		t.Fatalf("deleted flow listed: %+v", list.Data)
	}
	if n := f.e.count(`SELECT count(*) FROM audit_logs WHERE action LIKE 'flow.%'`); n != 4 {
		t.Fatalf("flow audit rows: %d", n) // 2 create + 1 update + 1 delete
	}
}
