// Package dsl is the Go port of web/src/lib/steps.ts: the Step DSL action catalog,
// validation (validateSteps) and human-readable summaries (summarizeStep, English).
// Keep it in sync with the TypeScript catalog — docs/04-test-definition.md is the spec.
package dsl

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
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
	{"set_viewport", "navigation", KindUI, []Param{p("width", "Width (px)", true), p("height", "Height (px)", true)}},
	{"expect_no_horizontal_scroll", "assert_ui", KindUI, []Param{p("selector", "Container selector", false), p("tolerance_px", "Tolerance (px)", false)}},
	{"http_request", "http", KindHTTP, []Param{p("method", "Method", true), p("url", "URL", true), p("headers", "Headers", false), p("query", "Query", false), p("body_type", "Body type", false), p("body", "Body", false), p("save", "Save to variables (name → JSONPath)", false), p("save_regex", "Save with regex (name → pattern)", false), p("regex_decode", "Decode body before regex", false), p("poll_timeout_ms", "Poll for up to (ms)", false), p("poll_interval_ms", "Poll interval (ms)", false), p("poll_until", "Poll until (JSONPath)", false)}},
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
		if msg := onlyOnError(st); msg != "" {
			errs = append(errs, FieldError{path + ".only_on", msg})
		}

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
		// expect_status accepts either `value` (one code) or `in` (list of allowed codes)
		statusList := false
		if act == "expect_status" {
			if l, ok := st["in"].([]any); ok && len(l) > 0 {
				statusList = true
			}
		}
		for _, prm := range def.Params {
			if statusList && prm.Name == "value" {
				continue
			}
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
		if act == "http_request" {
			errs = append(errs, validateHTTPExtras(st, path)...)
		}
		if act == "set_viewport" {
			for _, r := range []struct {
				name, label string
				lo, hi      float64
			}{{"width", "Width", ViewportMinWidth, ViewportMaxWidth}, {"height", "Height", ViewportMinHeight, ViewportMaxHeight}} {
				if present(st[r.name]) && !st.intIn(r.name, r.lo, r.hi) {
					errs = append(errs, FieldError{path + "." + r.name, fmt.Sprintf("%s must be a whole number between %g and %g", r.label, r.lo, r.hi)})
				}
			}
		}
		if act == "expect_no_horizontal_scroll" && present(st["tolerance_px"]) && !st.intIn("tolerance_px", 0, TolerancePxMax) {
			errs = append(errs, FieldError{path + ".tolerance_px", fmt.Sprintf("Tolerance must be a whole number between 0 and %d px", TolerancePxMax)})
		}
		seenFn := map[string]bool{}
		for _, fi := range fnIssues(st) {
			fe := FieldError{path + "." + fi.field, fi.message}
			key := fmt.Sprint(fi.warning, "|", fe.Path, "|", fe.Message)
			if seenFn[key] {
				continue
			}
			seenFn[key] = true
			if fi.warning {
				warnings = append(warnings, fe)
			} else {
				errs = append(errs, fe)
			}
		}
	}
	return errs, warnings
}

/* ------------------------------------------------------------------ http_request: regex & polling */

// RegexDecodeValues are the accepted http_request regex_decode values.
var RegexDecodeValues = []string{"none", "quoted_printable", "html", "auto"}

const (
	PollTimeoutMaxMS  = 120000
	PollIntervalMinMS = 200
	saveRegexMaxChars = 1000
)

func present(v any) bool {
	if v == nil {
		return false
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s) != ""
	}
	return true
}

func (s Step) number(key string) (float64, bool) {
	n, err := strconv.ParseFloat(strings.TrimSpace(s.Str(key)), 64)
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}

// validateHTTPExtras checks poll_timeout_ms, poll_interval_ms, regex_decode and save_regex.
// Paths and messages are identical to validateSteps in web/src/lib/steps.ts.
//
// save_regex patterns are JavaScript regular expressions (the runner compiles them with
// `new RegExp`). Go's RE2 rejects valid JS syntax (lookbehind, backreferences, …) and accepts
// some invalid JS, so compiling here would give wrong answers: the server only checks that each
// pattern is non-empty and not too long; the editor (TS) and the runner report invalid syntax.
func validateHTTPExtras(st Step, path string) []FieldError {
	var errs []FieldError
	if present(st["poll_timeout_ms"]) {
		if n, ok := st.number("poll_timeout_ms"); !ok || n < 0 || n > PollTimeoutMaxMS {
			errs = append(errs, FieldError{path + ".poll_timeout_ms", "Polling timeout must be between 0 and 120000 ms"})
		}
	}
	if present(st["poll_interval_ms"]) {
		if n, ok := st.number("poll_interval_ms"); !ok || n < PollIntervalMinMS {
			errs = append(errs, FieldError{path + ".poll_interval_ms", "Polling interval must be at least 200 ms"})
		}
	}
	if present(st["regex_decode"]) && !slices.Contains(RegexDecodeValues, st.Str("regex_decode")) {
		errs = append(errs, FieldError{path + ".regex_decode", "Regex decode must be one of: none, quoted_printable, html, auto"})
	}
	if m, ok := st["save_regex"].(map[string]any); ok {
		names := make([]string, 0, len(m))
		for k := range m {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, name := range names {
			pattern := Step{"p": m[name]}.Str("p")
			switch {
			case strings.TrimSpace(pattern) == "":
				errs = append(errs, FieldError{path + ".save_regex", `Regex for "` + name + `" is required`})
			case utf8.RuneCountInString(pattern) > saveRegexMaxChars:
				errs = append(errs, FieldError{path + ".save_regex", `Regex for "` + name + `" is too long (max 1000 characters)`})
			}
		}
	}
	return errs
}

/* ------------------------------------------------------------------ responsive steps (docs/14) */

// Limits of set_viewport and expect_no_horizontal_scroll.
const (
	ViewportMinWidth  = 320
	ViewportMaxWidth  = 3840
	ViewportMinHeight = 320
	ViewportMaxHeight = 2160
	TolerancePxMax    = 50
)

// DeviceCategories are the only_on values (OpenAPI DeviceCategory).
var DeviceCategories = []string{"mobile", "tablet", "desktop"}

// intIn reports whether a param is a whole number (number or numeric string) in [lo, hi].
func (s Step) intIn(key string, lo, hi float64) bool {
	n, ok := s.number(key)
	return ok && n == math.Trunc(n) && n >= lo && n <= hi
}

// onlyOnError checks the common only_on field: absent (or null) = every
// device; otherwise a non-empty list of distinct device categories.
func onlyOnError(st Step) string {
	v, ok := st["only_on"]
	if !ok || v == nil {
		return ""
	}
	list, ok := v.([]any)
	if !ok {
		return "Only on must be a list of device categories (mobile, tablet, desktop)"
	}
	if len(list) == 0 {
		return "Choose at least one device category, or remove only_on to run the step on every device"
	}
	seen := map[string]bool{}
	for _, x := range list {
		c, ok := x.(string)
		if !ok || !slices.Contains(DeviceCategories, c) {
			return fmt.Sprintf("Unknown device category %s; use mobile, tablet or desktop", Step{"v": x}.Str("v"))
		}
		if seen[c] {
			return fmt.Sprintf("Device category %q is listed twice", c)
		}
		seen[c] = true
	}
	return ""
}

// OnlyOn returns the step's only_on categories (nil = every device). Values
// that are not strings are dropped; the list is only meaningful for steps
// that passed Validate.
func (s Step) OnlyOn() []string {
	list, ok := s["only_on"].([]any)
	if !ok || len(list) == 0 {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, x := range list {
		if c, ok := x.(string); ok {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// AppliesTo reports whether the step runs on a device of category (no only_on → always).
func (s Step) AppliesTo(category string) bool {
	only := s.OnlyOn()
	return only == nil || slices.Contains(only, category)
}

/* ------------------------------------------------------------------ fn.* checks */

// FnNames are the built-in {{fn.*}} functions of the runner.
var FnNames = []string{"uuid", "now", "random_email", "random_int", "totp"}

var (
	fnToken     = regexp.MustCompile(`\{\{\s*fn\.([\w-]+)((?:\s+[^{}]*?)?)\s*\}\}`)
	totpRef     = regexp.MustCompile(`^(secret|env|vars)\.[\w-]+$`)
	totpLiteral = regexp.MustCompile(`^[A-Za-z2-7-]+=*$`)
	totpOption  = regexp.MustCompile(`(?i)^(digits|period|algorithm)=(.+)$`)
	allDigits   = regexp.MustCompile(`^\d+$`)
)

const totpOptionsHint = " (digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512)"

type fnIssue struct {
	field   string
	message string
	warning bool
}

// totpArgsError checks `{{fn.totp <ref> [digits=6] [period=30] [algorithm=SHA1]}}` (ranges = runner/src/totp.ts).
func totpArgsError(args []string) string {
	if len(args) == 0 || strings.Contains(args[0], "=") {
		return "fn.totp needs a seed: secret.NAME, env.NAME, vars.name or a base32 literal"
	}
	if !totpRef.MatchString(args[0]) && !totpLiteral.MatchString(args[0]) {
		return "fn.totp seed must be secret.NAME, env.NAME, vars.name or a base32 literal"
	}
	seen := map[string]bool{}
	for _, a := range args[1:] {
		m := totpOption.FindStringSubmatch(a)
		option := "…" // a bare argument may be part of a literal seed: never echo it
		if k, _, ok := strings.Cut(a, "="); ok {
			option = k
		}
		if m == nil || seen[strings.ToLower(m[1])] {
			return `fn.totp: invalid option "` + option + `"` + totpOptionsHint
		}
		k, v := strings.ToLower(m[1]), m[2]
		seen[k] = true
		var valid bool
		switch k {
		case "algorithm":
			valid = slices.Contains([]string{"SHA1", "SHA256", "SHA512"}, strings.Replace(strings.ToUpper(v), "-", "", 1))
		default:
			n, err := strconv.Atoi(v)
			valid = allDigits.MatchString(v) && err == nil && ((k == "digits" && n >= 6 && n <= 8) || (k == "period" && n >= 10 && n <= 300))
		}
		if !valid {
			return `fn.totp: invalid option "` + k + `"` + totpOptionsHint
		}
	}
	return ""
}

func collectStrings(v any, out []string) []string {
	switch t := v.(type) {
	case string:
		out = append(out, t)
	case []any:
		for _, x := range t {
			out = collectStrings(x, out)
		}
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			out = collectStrings(t[k], out)
		}
	}
	return out
}

// fnIssues reports {{fn.*}} problems in every param (not id/action/description/expected), fields sorted by name.
func fnIssues(st Step) []fnIssue {
	fields := make([]string, 0, len(st))
	for k := range st {
		switch k {
		case "id", "action", "description", "expected":
			continue
		}
		fields = append(fields, k)
	}
	sort.Strings(fields)
	var out []fnIssue
	for _, field := range fields {
		for _, text := range collectStrings(st[field], nil) {
			for _, m := range fnToken.FindAllStringSubmatch(text, -1) {
				name := m[1]
				args := strings.Fields(m[2])
				switch {
				case !slices.Contains(FnNames, name):
					out = append(out, fnIssue{field, `Unknown function "fn.` + name + `"`, true})
				case name == "totp":
					if msg := totpArgsError(args); msg != "" {
						out = append(out, fnIssue{field, msg, false})
					}
				}
			}
		}
	}
	return out
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

// pollSuffix is " (poll ≤15s)" when http_request polls (seconds rounded to one decimal, as in steps.ts).
func pollSuffix(s Step) string {
	ms, ok := s.number("poll_timeout_ms")
	if !ok || ms <= 0 {
		return ""
	}
	return " (poll ≤" + strconv.FormatFloat(math.Round(ms/100)/10, 'f', -1, 64) + "s)"
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
	case "set_viewport":
		return "Set viewport " + s.Str("width") + "×" + s.Str("height")
	case "expect_no_horizontal_scroll":
		if sel != "" {
			return "Expect no horizontal scroll in " + sel
		}
		return "Expect no horizontal scroll"
	case "http_request":
		m := s.Str("method")
		if m == "" {
			m = "GET"
		}
		return m + " " + s.Str("url") + pollSuffix(s)
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
