// Package dsl is the Go port of web/src/lib/steps.ts: the Step DSL action catalog,
// validation (validateSteps) and human-readable summaries (summarizeStep, English).
// Keep it in sync with the TypeScript catalog — docs/04-test-definition.md is the spec.
package dsl

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Step is one DSL step. Params depend on the action, so it is kept as a JSON object
// (unknown fields survive a round trip unchanged).
type Step map[string]any

// FieldError mirrors the API FieldError {path, message}.
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type Kind string

const (
	KindUI     Kind = "ui"
	KindHTTP   Kind = "http"
	KindCommon Kind = "common"
	KindManual Kind = "manual"
)

type Param struct {
	Name     string
	Label    string
	Required bool
}

type Action struct {
	Name   string
	Group  string
	Kind   Kind
	Params []Param
}

func p(name, label string, required bool) Param { return Param{name, label, required} }

var (
	selReq   = p("selector", "Selector", true)
	selOpt   = p("selector", "Selector", false)
	matchOpt = p("match", "Operator", false)
)

// Catalog in the same order as ACTIONS in steps.ts.
var Catalog = []Action{
	{"goto", "navigation", KindUI, []Param{p("url", "URL", true)}},
	{"click", "interaction", KindUI, []Param{selReq}},
	{"dblclick", "interaction", KindUI, []Param{selReq}},
	{"hover", "interaction", KindUI, []Param{selReq}},
	{"fill", "interaction", KindUI, []Param{selReq, p("value", "Value", true)}},
	{"type", "interaction", KindUI, []Param{selReq, p("value", "Text", true), p("delay_ms", "Delay between keys (ms)", false)}},
	{"press", "interaction", KindUI, []Param{p("key", "Key", true), selOpt}},
	{"select_option", "interaction", KindUI, []Param{selReq, p("value", "Value", false), p("label", "Option label", false)}},
	{"check", "interaction", KindUI, []Param{selReq}},
	{"uncheck", "interaction", KindUI, []Param{selReq}},
	{"wait_for", "wait", KindUI, []Param{selReq, p("state", "State", false)}},
	{"wait", "wait", KindCommon, []Param{p("ms", "Duration (ms)", true)}},
	{"screenshot", "data", KindUI, []Param{p("name", "Name", false), p("full_page", "Full page", false)}},
	{"extract_text", "data", KindUI, []Param{selReq, p("save_as", "Save as", true)}},
	{"set_variable", "data", KindCommon, []Param{p("name", "Name", true), p("value", "Value", true)}},
	{"expect_visible", "assert_ui", KindUI, []Param{selReq}},
	{"expect_hidden", "assert_ui", KindUI, []Param{selReq}},
	{"expect_text", "assert_ui", KindUI, []Param{selReq, p("value", "Text", true), matchOpt}},
	{"expect_value", "assert_ui", KindUI, []Param{selReq, p("value", "Value", true), matchOpt}},
	{"expect_url", "assert_ui", KindUI, []Param{p("value", "URL", true), matchOpt}},
	{"expect_title", "assert_ui", KindUI, []Param{p("value", "Title", true), matchOpt}},
	{"expect_count", "assert_ui", KindUI, []Param{selReq, p("op", "Operator", false), p("value", "Count", true)}},
	{"http_request", "http", KindHTTP, []Param{p("method", "Method", true), p("url", "URL", true), p("headers", "Headers", false), p("query", "Query", false), p("body_type", "Body type", false), p("body", "Body", false), p("save", "Save to variables (name → JSONPath)", false)}},
	{"expect_status", "assert_http", KindHTTP, []Param{p("value", "Status", true)}},
	{"expect_json", "assert_http", KindHTTP, []Param{p("path", "JSONPath", true), p("op", "Operator", true), p("value", "Value", false)}},
	{"expect_header", "assert_http", KindHTTP, []Param{p("name", "Header name", true), p("value", "Value", true), matchOpt}},
	{"expect_response_time", "assert_http", KindHTTP, []Param{p("max_ms", "Max (ms)", true)}},
	{"manual", "manual", KindManual, nil},
}

var byName = func() map[string]*Action {
	m := make(map[string]*Action, len(Catalog))
	for i := range Catalog {
		m[Catalog[i].Name] = &Catalog[i]
	}
	return m
}()

// Lookup returns the catalog entry for an action name.
func Lookup(name string) (*Action, bool) {
	a, ok := byName[name]
	return a, ok
}

/* ------------------------------------------------------------------ accessors */

func (s Step) Action() string { return s.Str("action") }
func (s Step) ID() string     { return s.Str("id") }

// Str returns a param as display string ("" when absent). Numbers are formatted without exponent.
func (s Step) Str(key string) string {
	v, ok := s[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	case bool:
		return strconv.FormatBool(t)
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

// Has reports whether a param is present and enabled-looking.
func (s Step) Bool(key string) bool {
	b, ok := s[key].(bool)
	return ok && b
}

// Enabled defaults to true.
func (s Step) Enabled() bool {
	b, ok := s["enabled"].(bool)
	return !ok || b
}

// IsUI reports whether the step needs a browser.
func (s Step) IsUI() bool {
	a, ok := Lookup(s.Action())
	return ok && a.Kind == KindUI
}

func isEmpty(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case map[string]any:
		return len(t) == 0
	case []any:
		return len(t) == 0
	}
	return false
}

/* ------------------------------------------------------------------ validation */

// Validate ports validateSteps(steps, execution). execution is "automated" or "manual".
func Validate(steps []Step, execution string) (errs, warnings []FieldError) {
	errs, warnings = []FieldError{}, []FieldError{}
	if execution == "" {
		execution = "automated"
	}
	if len(steps) == 0 {
		warnings = append(warnings, FieldError{"steps", "Test case has no steps yet"})
	}
	seen := map[string]bool{}
	sawHTTP := false
	for i, st := range steps {
		path := fmt.Sprintf("steps[%d]", i)
		id := st.ID()
		switch {
		case id == "":
			errs = append(errs, FieldError{path + ".id", "Step ID is required"})
		case seen[id]:
			errs = append(errs, FieldError{path + ".id", fmt.Sprintf("Step ID %q is a duplicate", id)})
		}
		seen[id] = true

		act := st.Action()
		def, ok := Lookup(act)
		if !ok {
			errs = append(errs, FieldError{path + ".action", fmt.Sprintf("Unknown action %q", act)})
			continue
		}
		if execution == "manual" && act != "manual" {
			errs = append(errs, FieldError{path + ".action", "Manual test cases can only contain manual steps"})
		}
		if execution == "automated" && act == "manual" {
			errs = append(errs, FieldError{path + ".action", "Manual steps aren't allowed in automated test cases"})
		}
		if act == "manual" && isEmpty(st["description"]) {
			errs = append(errs, FieldError{path + ".description", "Manual step instructions are required"})
		}
		for _, prm := range def.Params {
			if prm.Required && isEmpty(st[prm.Name]) {
				errs = append(errs, FieldError{path + "." + prm.Name, prm.Label + " is required"})
			}
		}
		if act == "wait" {
			ms, _ := strconv.ParseFloat(st.Str("ms"), 64)
			if ms > 30000 {
				errs = append(errs, FieldError{path + ".ms", "Pause is limited to 30000 ms"})
			} else {
				warnings = append(warnings, FieldError{path + ".action", `Fixed pauses make tests slow and flaky; consider "Wait for element"`})
			}
		}
		if act == "expect_text" && st.Str("match") == "regex" {
			if _, err := regexp.Compile(st.Str("value")); err != nil {
				errs = append(errs, FieldError{path + ".value", "Invalid regex"})
			}
		}
		if def.Group == "assert_http" && !sawHTTP {
			errs = append(errs, FieldError{path + ".action", `HTTP assertions need an "HTTP request" step before them`})
		}
		if act == "http_request" {
			sawHTTP = true
		}
		if strings.HasPrefix(strings.TrimSpace(st.Str("selector")), "//") {
			warnings = append(warnings, FieldError{path + ".selector", "XPath is brittle; use role=, label= or testid="})
		}
	}
	return errs, warnings
}

/* ------------------------------------------------------------------ summary */

func q(v string) string { return `"` + v + `"` }

func matchWord(m string) string {
	switch m {
	case "equals":
		return "="
	case "regex":
		return "~"
	}
	return "⊃"
}

func countOp(op string) string {
	switch op {
	case "gte":
		return "≥"
	case "lte":
		return "≤"
	}
	return "="
}

// Summarize ports summarizeStep (English). Callers interpolate the step first if needed.
func Summarize(s Step) string {
	sel := s.Str("selector")
	switch s.Action() {
	case "goto":
		return "Open " + s.Str("url")
	case "click":
		return "Click " + sel
	case "dblclick":
		return "Double-click " + sel
	case "hover":
		return "Hover " + sel
	case "fill":
		return "Fill " + sel + " with " + q(s.Str("value"))
	case "type":
		return "Type " + q(s.Str("value")) + " into " + sel
	case "press":
		if sel != "" {
			return "Press " + s.Str("key") + " on " + sel
		}
		return "Press " + s.Str("key")
	case "select_option":
		v := s.Str("label")
		if v == "" {
			v = s.Str("value")
		}
		return "Select " + q(v) + " in " + sel
	case "check":
		return "Check " + sel
	case "uncheck":
		return "Uncheck " + sel
	case "wait_for":
		st := s.Str("state")
		if st == "" {
			st = "visible"
		}
		return "Wait for " + sel + " " + st
	case "wait":
		ms := s.Str("ms")
		if ms == "" {
			ms = "0"
		}
		return "Pause " + ms + " ms"
	case "screenshot":
		if n := s.Str("name"); n != "" {
			return "Screenshot " + q(n)
		}
		return "Screenshot"
	case "extract_text":
		return "Extract text of " + sel + " → vars." + s.Str("save_as")
	case "set_variable":
		return "vars." + s.Str("name") + " = " + q(s.Str("value"))
	case "expect_visible":
		return sel + " is visible"
	case "expect_hidden":
		return sel + " is hidden"
	case "expect_text":
		return "Text of " + sel + " " + matchWord(s.Str("match")) + " " + q(s.Str("value"))
	case "expect_value":
		return "Value of " + sel + " " + matchWord(s.Str("match")) + " " + q(s.Str("value"))
	case "expect_url":
		return "URL " + matchWord(s.Str("match")) + " " + q(s.Str("value"))
	case "expect_title":
		return "Title " + matchWord(s.Str("match")) + " " + q(s.Str("value"))
	case "expect_count":
		return "Count of " + sel + " " + countOp(s.Str("op")) + " " + s.Str("value")
	case "http_request":
		m := s.Str("method")
		if m == "" {
			m = "GET"
		}
		return m + " " + s.Str("url")
	case "expect_status":
		return "Status = " + s.Str("value")
	case "expect_json":
		op := s.Str("op")
		if op == "" {
			op = "eq"
		}
		if op == "exists" {
			return s.Str("path") + " " + op
		}
		return s.Str("path") + " " + op + " " + q(s.Str("value"))
	case "expect_header":
		return "Header " + s.Str("name") + " " + matchWord(s.Str("match")) + " " + q(s.Str("value"))
	case "expect_response_time":
		return "Response time ≤ " + s.Str("max_ms") + " ms"
	case "manual":
		if d := s.Str("description"); d != "" {
			return d
		}
		return "Manual step"
	}
	return s.Action()
}

/* ------------------------------------------------------------------ interpolation (display only) */

var varRe = regexp.MustCompile(`\{\{\s*([\w.]+)(?:\s+[^}]*)?\s*\}\}`)

// InterpolateForDisplay resolves {{env.X}} from env, masks {{secret.X}} as ••••, and leaves
// vars/fn placeholders untouched. Used for run step summaries (never for execution).
func InterpolateForDisplay(text string, env map[string]string) string {
	return varRe.ReplaceAllStringFunc(text, func(whole string) string {
		m := varRe.FindStringSubmatch(whole)
		ns, key, _ := strings.Cut(m[1], ".")
		switch ns {
		case "env":
			if v, ok := env[key]; ok {
				return v
			}
		case "secret":
			return "••••"
		}
		return whole
	})
}

// DisplayStep returns a copy of the step with every string param interpolated for display.
func DisplayStep(s Step, env map[string]string) Step {
	out := make(Step, len(s))
	for k, v := range s {
		if str, ok := v.(string); ok && k != "id" && k != "action" {
			out[k] = InterpolateForDisplay(str, env)
		} else {
			out[k] = v
		}
	}
	return out
}
