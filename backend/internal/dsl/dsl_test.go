package dsl

import "testing"

func paths(fe []FieldError) map[string]bool {
	m := map[string]bool{}
	for _, e := range fe {
		m[e.Path] = true
	}
	return m
}

func TestValidateValid(t *testing.T) {
	errs, _ := Validate([]Step{
		{"id": "a", "action": "goto", "url": "{{env.BASE_URL}}/login"},
		{"id": "b", "action": "click", "selector": "role=button[name='Masuk']"},
		{"id": "c", "action": "expect_url", "value": "/akun", "match": "contains"},
	}, "automated")
	if len(errs) != 0 {
		t.Fatalf("unexpected errors: %+v", errs)
	}
}

func TestValidateErrors(t *testing.T) {
	errs, _ := Validate([]Step{{"id": "a", "action": "click"}, {"id": "a", "action": "wait", "ms": float64(45000)}}, "automated")
	got := paths(errs)
	for _, want := range []string{"steps[0].selector", "steps[1].id", "steps[1].ms"} {
		if !got[want] {
			t.Errorf("missing %s in %+v", want, errs)
		}
	}
	errs, _ = Validate([]Step{{"id": "a", "action": "expect_status", "value": float64(200)}}, "automated")
	if len(errs) != 1 || errs[0].Path != "steps[0].action" {
		t.Errorf("http assert without request: %+v", errs)
	}
	if e, _ := Validate([]Step{{"id": "a", "action": "manual", "description": "x"}}, "automated"); len(e) != 1 {
		t.Errorf("manual in automated: %+v", e)
	}
	if e, _ := Validate([]Step{{"id": "a", "action": "manual"}}, "manual"); len(e) != 1 || e[0].Path != "steps[0].description" {
		t.Errorf("manual without description: %+v", e)
	}
	if e, _ := Validate([]Step{{"id": "a", "action": "expect_text", "selector": "#x", "value": "([", "match": "regex"}}, "automated"); !paths(e)["steps[0].value"] {
		t.Errorf("bad regex: %+v", e)
	}
	if e, _ := Validate([]Step{{"id": "a", "action": "nope"}}, "automated"); len(e) != 1 {
		t.Errorf("unknown action: %+v", e)
	}
}

func TestSummarize(t *testing.T) {
	cases := map[string]Step{
		`Fill label=Email with "qa@x.id"`:          {"action": "fill", "selector": "label=Email", "value": "qa@x.id"},
		"POST /orders":                             {"action": "http_request", "method": "POST", "url": "/orders"},
		`Text of testid=grand-total = "Rp 81.000"`: {"action": "expect_text", "selector": "testid=grand-total", "value": "Rp 81.000", "match": "equals"},
		"Count of testid=product-card ≥ 1":         {"action": "expect_count", "selector": "testid=product-card", "op": "gte", "value": float64(1)},
		"$.data.id exists":                         {"action": "expect_json", "path": "$.data.id", "op": "exists"},
		"Press Enter on placeholder=Cari produk":   {"action": "press", "key": "Enter", "selector": "placeholder=Cari produk"},
	}
	for want, st := range cases {
		if got := Summarize(st); got != want {
			t.Errorf("Summarize(%v) = %q, want %q", st, got, want)
		}
	}
}

func TestDisplayStepMasksSecrets(t *testing.T) {
	s := DisplayStep(Step{"id": "x", "action": "fill", "selector": "label=Password", "value": "{{secret.QA_PASSWORD}}", "url": "{{env.BASE_URL}}/a {{vars.x}}"}, map[string]string{"BASE_URL": "https://s.t"})
	if s.Str("value") != "••••" || s.Str("url") != "https://s.t/a {{vars.x}}" {
		t.Fatalf("got %v", s)
	}
}
