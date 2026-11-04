package dsl

import (
	"reflect"
	"strings"
	"testing"
)

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

func req(extra Step) Step {
	s := Step{"id": "a", "action": "http_request", "method": "GET", "url": "{{env.MAILPIT_URL}}/api/v1/search"}
	for k, v := range extra {
		s[k] = v
	}
	return s
}

func TestSummarizePolling(t *testing.T) {
	url := "{{env.MAILPIT_URL}}/api/v1/search?query=to:{{vars.email}}"
	cases := map[string]Step{
		"GET " + url + " (poll ≤15s)":  req(Step{"url": url, "poll_timeout_ms": float64(15000)}),
		"GET " + url + " (poll ≤1.5s)": req(Step{"url": url, "poll_timeout_ms": float64(1500)}),
		"GET " + url:                   req(Step{"url": url, "poll_timeout_ms": float64(0)}),
		"POST " + url:                  req(Step{"url": url, "method": "POST"}),
	}
	for want, st := range cases {
		if got := Summarize(st); got != want {
			t.Errorf("Summarize(%v) = %q, want %q", st, got, want)
		}
	}
}

func TestValidateHTTPExtras(t *testing.T) {
	errs, warns := Validate([]Step{
		req(Step{"save": map[string]any{"id": "$.messages[0].ID"}, "poll_timeout_ms": float64(15000), "poll_interval_ms": float64(500), "poll_until": "$.messages[0]"}),
		req(Step{"id": "b", "save_regex": map[string]any{"otp": `code: (\d{6})`, "link": `/href="([^"]+)"/i`}, "regex_decode": "auto", "poll_timeout_ms": float64(0)}),
	}, "automated")
	if len(errs) != 0 || len(warns) != 0 {
		t.Fatalf("valid polling/regex: errs %+v warns %+v", errs, warns)
	}

	errs, _ = Validate([]Step{
		req(Step{"poll_timeout_ms": float64(130000), "poll_interval_ms": float64(100), "regex_decode": "base64",
			"save_regex": map[string]any{"z": "(?<=x)y", "a": "", "m": strings.Repeat("x", 1001)}}),
		req(Step{"id": "b", "poll_timeout_ms": float64(-1)}),
	}, "automated")
	want := []FieldError{
		{"steps[0].poll_timeout_ms", "Polling timeout must be between 0 and 120000 ms"},
		{"steps[0].poll_interval_ms", "Polling interval must be at least 200 ms"},
		{"steps[0].regex_decode", "Regex decode must be one of: none, quoted_printable, html, auto"},
		{"steps[0].save_regex", `Regex for "a" is required`},
		{"steps[0].save_regex", `Regex for "m" is too long (max 1000 characters)`},
		// "z" uses JS lookbehind: valid for the runner, not compiled here (see validateHTTPExtras).
		{"steps[1].poll_timeout_ms", "Polling timeout must be between 0 and 120000 ms"},
	}
	if !reflect.DeepEqual(errs, want) {
		t.Fatalf("errors:\n got %+v\nwant %+v", errs, want)
	}
}

func TestValidateFn(t *testing.T) {
	fill := func(id, value string) Step {
		return Step{"id": id, "action": "fill", "selector": "label=Code", "value": value}
	}
	for i, v := range []string{
		"{{fn.totp secret.OTP_SEED}}",
		"{{ fn.totp env.OTP }}",
		"{{fn.totp vars.otp_seed digits=8 period=60 algorithm=sha256}}",
		"{{fn.totp JBSWY3DPEHPK3PXP}}",
		"pre {{fn.uuid}} {{fn.random_int 1 9}} {{fn.totp secret.X algorithm=SHA512}}",
	} {
		if errs, warns := Validate([]Step{fill("a", v)}, "automated"); len(errs) != 0 || len(warns) != 0 {
			t.Errorf("%d %q: errs %+v warns %+v", i, v, errs, warns)
		}
	}
	const hint = " (digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512)"
	errs, warns := Validate([]Step{
		fill("a", "{{fn.totp}}"),
		fill("b", "{{fn.totp 1234}}"),
		fill("c", "{{fn.totp secret.X digits=9}}"),
		fill("d", "{{fn.totp JBSW Y3DP}}"),
		{"id": "e", "action": "http_request", "method": "POST", "url": "{{env.API}}/x?{{fn.nope}}",
			"headers": map[string]any{"X-Otp": "{{fn.totp secret.X foo=1}}", "X-Dup": "{{fn.nope}}"}},
		{"id": "f", "action": "fill", "selector": "#x", "value": "x", "description": "{{fn.nope}}", "expected": "{{fn.totp}}"},
	}, "automated")
	wantErrs := []FieldError{
		{"steps[0].value", "fn.totp needs a seed: secret.NAME, env.NAME, vars.name or a base32 literal"},
		{"steps[1].value", "fn.totp seed must be secret.NAME, env.NAME, vars.name or a base32 literal"},
		{"steps[2].value", `fn.totp: invalid option "digits"` + hint},
		{"steps[3].value", `fn.totp: invalid option "…"` + hint},
		{"steps[4].headers", `fn.totp: invalid option "foo"` + hint},
	}
	wantWarns := []FieldError{
		{"steps[4].headers", `Unknown function "fn.nope"`},
		{"steps[4].url", `Unknown function "fn.nope"`},
	}
	if !reflect.DeepEqual(errs, wantErrs) {
		t.Errorf("errors:\n got %+v\nwant %+v", errs, wantErrs)
	}
	if !reflect.DeepEqual(warns, wantWarns) {
		t.Errorf("warnings:\n got %+v\nwant %+v", warns, wantWarns)
	}
}

func TestDisplayStepKeepsTotpExpression(t *testing.T) {
	s := DisplayStep(Step{"id": "x", "action": "fill", "selector": "label=Code", "value": "{{fn.totp secret.OTP_SEED}}"}, map[string]string{})
	if got := Summarize(s); got != `Fill label=Code with "{{fn.totp secret.OTP_SEED}}"` {
		t.Fatalf("summary %q", got)
	}
}
