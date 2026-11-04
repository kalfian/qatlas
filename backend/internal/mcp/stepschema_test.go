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
		{"id": "s1", "action": "goto"},                                        // url missing
		{"id": "s1", "action": "teleport"},                                    // unknown action
		{"id": "s1", "action": "expect_count", "selector": "x", "value": "3"}, // value must be an integer
	} {
		if err := r.Validate(bad); err == nil {
			t.Errorf("schema accepted %v", bad)
		}
	}
}
