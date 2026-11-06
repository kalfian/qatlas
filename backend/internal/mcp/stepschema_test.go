package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"

	"github.com/kalfian/qatlas/backend/internal/dsl"
)

// TestStepSchemaCoversCatalog fails when dsl.Catalog gains an action or
// parameter that paramSchema does not describe.
func TestStepSchemaCoversCatalog(t *testing.T) {
	for _, a := range dsl.Catalog {
		for _, p := range a.Params {
			if paramSchema(a.Name, p.Name) == nil {
				t.Errorf("no JSON schema for %s.%s", a.Name, p.Name)
			}
		}
	}
	sch := StepJSONSchema()
	if got, want := len(sch["allOf"].([]any)), len(dsl.Catalog); got != want {
		t.Fatalf("allOf branches = %d, want %d", got, want)
	}
	if !strings.Contains(stepDSLMarkdown(), "| expect_json | assert_http | path, op | value |") {
		t.Fatal("markdown action table is missing expect_json")
	}
}

func resolvedStepSchema(t *testing.T) *jsonschema.Resolved {
	t.Helper()
	raw, err := json.Marshal(StepJSONSchema())
	if err != nil {
		t.Fatal(err)
	}
	var s jsonschema.Schema
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	r, err := s.Resolve(nil)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return r
}

// TestStepSchemaExamples: the documented examples pass both the JSON Schema
// and the server-side DSL validation, and the schema rejects a broken step.
func TestStepSchemaExamples(t *testing.T) {
	r := resolvedStepSchema(t)
	for _, ex := range exampleCases() {
		raw, _ := json.Marshal(ex["steps"])
		var steps []map[string]any
		if err := json.Unmarshal(raw, &steps); err != nil {
			t.Fatal(err)
		}
		dsteps := make([]dsl.Step, len(steps))
		for i, st := range steps {
			if err := r.Validate(st); err != nil {
				t.Errorf("%s step %d: schema: %v", ex["title"], i, err)
			}
			dsteps[i] = dsl.Step(st)
		}
		errs, _ := dsl.Validate(dsteps, ex["execution"].(string))
		if len(errs) > 0 {
			t.Errorf("%s: dsl.Validate: %v", ex["title"], errs)
		}
	}
	for _, bad := range []map[string]any{
		{"id": "s1", "action": "goto"},                                                                            // url missing
		{"id": "s1", "action": "teleport"},                                                                        // unknown action
		{"id": "s1", "action": "expect_count", "selector": "x", "value": "3"},                                     // value must be an integer
		{"id": "s1", "action": "http_request", "method": "GET", "url": "x", "poll_timeout_ms": 999999},            // > 120000
		{"id": "s1", "action": "http_request", "method": "GET", "url": "x", "poll_interval_ms": 50},               // < 200
		{"id": "s1", "action": "http_request", "method": "GET", "url": "x", "regex_decode": "base64"},             // not in enum
		{"id": "s1", "action": "http_request", "method": "GET", "url": "x", "save_regex": map[string]any{"a": 1}}, // pattern must be a string
	} {
		if err := r.Validate(bad); err == nil {
			t.Errorf("schema accepted %v", bad)
		}
	}
}

// TestStepSchemaResponsive: the responsive actions and only_on pass both the
// JSON Schema and dsl.Validate; out-of-range values are rejected by both.
func TestStepSchemaResponsive(t *testing.T) {
	r := resolvedStepSchema(t)
	good := []map[string]any{
		{"id": "r1", "action": "set_viewport", "width": 768.0, "height": 1024.0},
		{"id": "r2", "action": "expect_no_horizontal_scroll", "selector": "testid=cart", "tolerance_px": 2.0, "only_on": []any{"mobile", "tablet"}},
		{"id": "r3", "action": "click", "selector": "role=button[name='Menu']", "only_on": []any{"mobile"}},
	}
	steps := make([]dsl.Step, len(good))
	for i, st := range good {
		if err := r.Validate(st); err != nil {
			t.Errorf("schema rejected %v: %v", st, err)
		}
		steps[i] = dsl.Step(st)
	}
	if errs, _ := dsl.Validate(steps, "automated"); len(errs) > 0 {
		t.Errorf("dsl.Validate: %v", errs)
	}
	for _, bad := range []map[string]any{
		{"id": "r1", "action": "set_viewport", "width": 768.0},                                  // height missing
		{"id": "r1", "action": "set_viewport", "width": 200.0, "height": 1024.0},                // < 320
		{"id": "r1", "action": "expect_no_horizontal_scroll", "tolerance_px": 60.0},             // > 50
		{"id": "r1", "action": "click", "selector": "#x", "only_on": []any{}},                   // empty
		{"id": "r1", "action": "click", "selector": "#x", "only_on": []any{"watch"}},            // unknown category
		{"id": "r1", "action": "click", "selector": "#x", "only_on": []any{"mobile", "mobile"}}, // duplicate
	} {
		if err := r.Validate(bad); err == nil {
			t.Errorf("schema accepted %v", bad)
		}
		if errs, _ := dsl.Validate([]dsl.Step{dsl.Step(bad)}, "automated"); len(errs) == 0 {
			t.Errorf("dsl.Validate accepted %v", bad)
		}
	}
	if !strings.Contains(stepDSLMarkdown(), "| set_viewport | navigation | width, height |  |") {
		t.Fatal("markdown action table is missing set_viewport")
	}
}
