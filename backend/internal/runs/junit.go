package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// JUnit export (docs/06 "Report", Phase 5): one <testsuite> per run inside a
// <testsuites> root, one <testcase> per run case. Mapping of case statuses:
//
//	passed            → plain <testcase>
//	failed            → <failure type="failed">
//	blocked (manual)  → <failure type="blocked"> (it did not pass; CI must not go green)
//	error             → <error type="error"> (infrastructure: runner crash, timeout, …)
//	skipped / pending → <skipped/> (pending/running only happen in cancelled/errored runs)
//
// Stored run data is already secret-masked (summaries "••••", worker masks
// error messages and details), so nothing here needs to unmask or re-mask.

// Limits keep the XML readable in CI viewers.
const (
	junitMessageChars = 500
	junitTextChars    = 2000
)

// JUnitFilename is the download name for a run's JUnit report.
func JUnitFilename(runKey string) string { return runKey + ".junit.xml" }

// JUnit returns the JUnit XML of a final run (view permission). Runs that are
// not final yet → 409 conflict.
func (s *Service) JUnit(ctx context.Context, actor *auth.Actor, runKey string) (Run, []byte, error) {
	run, err := s.Get(ctx, actor, runKey)
	if err != nil {
		return Run{}, nil, err
	}
	if !IsFinal(run.Status) {
		return Run{}, nil, httpx.Conflict(fmt.Sprintf("Run %s is %s; the JUnit report is available once the run has finished", run.Key, strings.ReplaceAll(run.Status, "_", " ")))
	}
	out, err := JUnitXML(run)
	if err != nil {
		return Run{}, nil, err
	}
	return run, out, nil
}

type junitSuite struct {
	Name, ID, Package, Time, Timestamp string
	Tests, Failures, Errors, Skipped   int
	Properties                         []junitProperty
	Cases                              []junitCase
	SystemErr                          string
}

type junitProperty struct{ Name, Value string }

type junitCase struct {
	ClassName, Name, Time string
	Failure, Error        *junitProblem
	Skipped               *junitSkipped
	SystemOut             string
}

type junitProblem struct{ Message, Type, Text string }

type junitSkipped struct{ Message string }

// JUnitXML renders the run as a JUnit XML document (Ant/Surefire flavour, as
// read by Jenkins, GitLab, GitHub test reporters). Pure function: no I/O. The
// document is written by hand (not encoding/xml) so text keeps real newlines
// and quotes, which keeps it readable in CI log viewers.
func JUnitXML(run Run) ([]byte, error) {
	suite := junitSuite{
		Name:      strings.TrimSpace(run.Target.Key + " " + run.Target.Title),
		ID:        run.Key,
		Package:   run.ProjectKey,
		Time:      seconds(run.DurationMS),
		Timestamp: junitTimestamp(run),
		Cases:     make([]junitCase, 0, len(run.Cases)),
	}
	suite.Properties = junitProperties(run)

	// Runs on several devices (docs/14): every case once per device, named
	// "{title} [{device label}]"; the classname stays the project key.
	multiDevice := len(run.Devices()) > 1
	type caseOnDevice struct {
		key    string
		device int
	}
	keyCount := map[caseOnDevice]int{}
	for _, c := range run.Cases {
		keyCount[caseOnDevice{c.TestCaseKey, c.DeviceIndex}]++
	}
	for _, c := range run.Cases {
		jc := junitCase{
			ClassName: run.ProjectKey,
			Name:      strings.TrimSpace(c.TestCaseKey + " " + c.Title),
			Time:      seconds(c.DurationMS),
		}
		if multiDevice {
			jc.Name += " [" + run.DeviceOf(c).Label + "]"
		}
		if keyCount[caseOnDevice{c.TestCaseKey, c.DeviceIndex}] > 1 { // the same case twice in a flow: keep names unique
			jc.Name += " [#" + strconv.Itoa(c.Position) + "]"
		}
		switch c.Status {
		case StepPassed:
		case StepFailed, StepBlocked:
			msg, text := problemOf(c, run)
			if c.Status == StepBlocked {
				msg = "Blocked: " + msg
			}
			jc.Failure = &junitProblem{Message: oneLine(msg, junitMessageChars), Type: c.Status, Text: text}
			suite.Failures++
		case StepError:
			msg, text := problemOf(c, run)
			jc.Error = &junitProblem{Message: oneLine(msg, junitMessageChars), Type: "error", Text: text}
			suite.Errors++
		default: // skipped, or pending/running left behind by a cancelled/errored run
			sk := &junitSkipped{}
			if c.Status != StepSkipped {
				sk.Message = "Not executed (run " + run.Status + ")"
			} else if run.Status == StatusCancelled {
				sk.Message = "Run cancelled"
			}
			jc.Skipped = sk
			suite.Skipped++
		}
		jc.SystemOut = caseOutput(c)
		suite.Cases = append(suite.Cases, jc)
	}
	suite.Tests = len(suite.Cases)
	if run.ErrorMessage != nil {
		suite.SystemErr = clean(*run.ErrorMessage, junitTextChars)
	}

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	counts := func(tests, failures, errors, skipped int, time string) string {
		return fmt.Sprintf(` tests="%d" failures="%d" errors="%d" skipped="%d" time="%s"`, tests, failures, errors, skipped, time)
	}
	b.WriteString(`<testsuites name="` + xmlAttr("QAtlas "+run.Key) + `"` + counts(suite.Tests, suite.Failures, suite.Errors, suite.Skipped, suite.Time) + ">\n")
	b.WriteString(`  <testsuite name="` + xmlAttr(suite.Name) + `" id="` + xmlAttr(suite.ID) + `" package="` + xmlAttr(suite.Package) + `"` +
		counts(suite.Tests, suite.Failures, suite.Errors, suite.Skipped, suite.Time) + ` timestamp="` + suite.Timestamp + "\">\n")
	b.WriteString("    <properties>\n")
	for _, p := range suite.Properties {
		b.WriteString(`      <property name="` + xmlAttr(p.Name) + `" value="` + xmlAttr(p.Value) + "\"/>\n")
	}
	b.WriteString("    </properties>\n")
	for _, c := range suite.Cases {
		b.WriteString(`    <testcase classname="` + xmlAttr(c.ClassName) + `" name="` + xmlAttr(c.Name) + `" time="` + c.Time + `"`)
		if c.Failure == nil && c.Error == nil && c.Skipped == nil && c.SystemOut == "" {
			b.WriteString("/>\n")
			continue
		}
		b.WriteString(">\n")
		for _, p := range []struct {
			tag string
			pr  *junitProblem
		}{{"failure", c.Failure}, {"error", c.Error}} {
			if p.pr != nil {
				b.WriteString(`      <` + p.tag + ` message="` + xmlAttr(p.pr.Message) + `" type="` + xmlAttr(p.pr.Type) + `">` + xmlText(p.pr.Text) + "</" + p.tag + ">\n")
			}
		}
		if c.Skipped != nil {
			if c.Skipped.Message != "" {
				b.WriteString(`      <skipped message="` + xmlAttr(c.Skipped.Message) + "\"/>\n")
			} else {
				b.WriteString("      <skipped/>\n")
			}
		}
		if c.SystemOut != "" {
			b.WriteString("      <system-out>" + xmlText(c.SystemOut) + "</system-out>\n")
		}
		b.WriteString("    </testcase>\n")
	}
	if suite.SystemErr != "" {
		b.WriteString("    <system-err>" + xmlText(suite.SystemErr) + "</system-err>\n")
	}
	b.WriteString("  </testsuite>\n</testsuites>\n")
	return []byte(b.String()), nil
}

var (
	xmlTextEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	xmlAttrEscaper = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;",
		"\n", "&#10;", "\r", "&#13;", "\t", "&#9;")
)

// xmlText escapes character data; the input must already be clean()ed.
func xmlText(s string) string { return xmlTextEscaper.Replace(clean(s, len(s)+1)) }

// xmlAttr escapes an attribute value (newlines kept as character references).
func xmlAttr(s string) string { return xmlAttrEscaper.Replace(clean(s, len(s)+1)) }

func junitProperties(run Run) []junitProperty {
	props := []junitProperty{
		{"qatlas.run", run.Key},
		{"qatlas.status", run.Status},
		{"qatlas.kind", run.Kind},
		{"qatlas.target", run.Target.Key},
		{"qatlas.trigger", run.Trigger},
		{"qatlas.triggered_by", run.TriggeredBy.Name},
	}
	if run.Environment != nil {
		props = append(props, junitProperty{"qatlas.environment", run.Environment.Name})
	}
	automated := false
	for _, c := range run.Cases {
		if c.Execution == ExecutionAutomated {
			automated = true
			break
		}
	}
	if automated {
		var opts struct {
			Browser string `json:"browser"`
		}
		if json.Unmarshal(run.Options, &opts) == nil && opts.Browser != "" {
			props = append(props, junitProperty{"qatlas.browser", opts.Browser})
		}
	}
	return props
}

// junitTimestamp is the run start (or queue time) in UTC without zone suffix,
// the format of the JUnit XSD (xs:dateTime pattern without timezone).
func junitTimestamp(run Run) string {
	t := run.QueuedAt
	if run.StartedAt != nil {
		t = *run.StartedAt
	}
	return t.UTC().Format("2006-01-02T15:04:05")
}

func seconds(ms *int64) string {
	if ms == nil || *ms < 0 {
		return "0.000"
	}
	return strconv.FormatFloat(float64(*ms)/1000, 'f', 3, 64)
}

func isProblem(status string) bool {
	return status == StepFailed || status == StepError || status == StepBlocked
}

// problemOf builds the failure/error message (first problem step) and the full
// text (every problem step with error and expected/actual).
func problemOf(c RunCase, run Run) (string, string) {
	var (
		msg   string
		parts []string
	)
	for _, s := range c.Steps {
		if !isProblem(s.Status) {
			continue
		}
		head := fmt.Sprintf("Step %d (%s) %s: %s", s.Position, s.StepID, s.Status, stepLabel(c, s))
		lines := []string{head}
		errText := ""
		if s.ErrorMessage != nil {
			errText = clean(*s.ErrorMessage, junitTextChars)
			lines = append(lines, "Error: "+errText)
		}
		lines = append(lines, expectedActual(c, s)...)
		if msg == "" {
			msg = fmt.Sprintf("Step %d: %s", s.Position, stepLabel(c, s))
			if errText != "" {
				msg += " — " + errText
			} else if c.Execution == ExecutionManual && s.ActualResult != nil && *s.ActualResult != "" {
				msg += " — " + clean(*s.ActualResult, junitTextChars)
			}
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	if msg == "" { // no step carries the problem (e.g. runner crash before the first step)
		msg = "Test case " + c.Status
		if run.ErrorMessage != nil && *run.ErrorMessage != "" {
			msg = clean(*run.ErrorMessage, junitTextChars)
		}
		parts = append(parts, msg)
	}
	return msg, strings.Join(parts, "\n\n")
}

// stepLabel is the summary for automated steps and the description for manual ones.
func stepLabel(c RunCase, s RunStep) string {
	label := s.Summary
	if c.Execution == ExecutionManual && strings.TrimSpace(s.Description) != "" {
		label = s.Description
	}
	if strings.TrimSpace(label) == "" {
		label = s.Action
	}
	return clean(label, junitMessageChars)
}

// expectedActual renders "Expected:"/"Actual:" from the runner details
// ({expected, actual} for assertions), the manual expected/actual result, or
// the HTTP response status.
func expectedActual(c RunCase, s RunStep) []string {
	var lines []string
	var d map[string]json.RawMessage
	_ = json.Unmarshal(s.Details, &d)
	expected, actual := jsonText(d["expected"]), jsonText(d["actual"])
	if expected == "" && strings.TrimSpace(s.Expected) != "" {
		expected = s.Expected
	}
	if actual == "" && s.ActualResult != nil {
		actual = *s.ActualResult
	}
	if expected != "" {
		lines = append(lines, "Expected: "+clean(expected, junitTextChars))
	}
	if actual != "" {
		lines = append(lines, "Actual: "+clean(actual, junitTextChars))
	}
	if resp, ok := d["response"]; ok {
		var r struct {
			Status *int `json:"status"`
		}
		if json.Unmarshal(resp, &r) == nil && r.Status != nil {
			lines = append(lines, "Response status: "+strconv.Itoa(*r.Status))
		}
	}
	return lines
}

func jsonText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

// caseOutput lists every step for <system-out>; manual cases also carry the
// tester's actual results and who executed them.
func caseOutput(c RunCase) string {
	var b strings.Builder
	if c.Execution == ExecutionManual {
		b.WriteString("Manual test case")
		if c.ExecutedBy != nil && c.ExecutedBy.Name != "" {
			b.WriteString(", executed by " + clean(c.ExecutedBy.Name, 200))
		}
		b.WriteString("\n")
	}
	for _, s := range c.Steps {
		fmt.Fprintf(&b, "%d. [%s] %s", s.Position, s.Status, stepLabel(c, s))
		if s.DurationMS != nil {
			fmt.Fprintf(&b, " (%d ms)", *s.DurationMS)
		}
		b.WriteString("\n")
		if c.Execution == ExecutionManual {
			if strings.TrimSpace(s.Expected) != "" {
				b.WriteString("   Expected: " + clean(s.Expected, junitTextChars) + "\n")
			}
			if s.ActualResult != nil && *s.ActualResult != "" {
				b.WriteString("   Actual result: " + clean(*s.ActualResult, junitTextChars) + "\n")
			}
		}
		if s.ErrorMessage != nil && *s.ErrorMessage != "" && !isProblem(s.Status) {
			b.WriteString("   Note: " + clean(*s.ErrorMessage, junitMessageChars) + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// clean strips ANSI colour codes (Playwright error messages), characters XML
// 1.0 cannot carry, and truncates to max runes.
func clean(s string, max int) string {
	s = ansiEscape.ReplaceAllString(s, "")
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '\t' || r == '\n' || r == '\r':
			return r
		case r < 0x20, r >= 0xD800 && r <= 0xDFFF, r == 0xFFFE, r == 0xFFFF, r == utf8.RuneError:
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		r := []rune(s)
		s = string(r[:max]) + "…"
	}
	return s
}

// oneLine is clean + whitespace collapsed (attribute values).
func oneLine(s string, max int) string {
	return clean(strings.Join(strings.Fields(clean(s, max*4)), " "), max)
}
