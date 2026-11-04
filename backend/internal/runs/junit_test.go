package runs

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
)

func ptr[T any](v T) *T { return &v }

func junitFixture() Run {
	started := time.Date(2026, 11, 4, 9, 30, 15, 0, time.FixedZone("WIB", 7*3600))
	finished := started.Add(12 * time.Second)
	step := func(pos int, id, action, summary, status string, ms int64) RunStep {
		return RunStep{ID: uuid.New(), Position: pos, StepID: id, Action: action, Summary: summary, Status: status,
			DurationMS: ptr(ms), Details: json.RawMessage("null")}
	}
	failed := step(2, "s2", "assert_text", `text "Total" contains "<Rp 10.000>"`, "failed", 5003)
	failed.ErrorMessage = ptr("\x1b[31mExpected\x1b[39m text to contain \"<Rp 10.000>\" & more\x00")
	failed.Details = json.RawMessage(`{"expected":"<Rp 10.000>","actual":"Rp 9.000 & \"tax\""}`)
	login := step(1, "s1", "fill", "fill label=Password with ••••", "passed", 120)
	errStep := step(1, "e1", "goto", "goto https://shop.example/", "error", 15000)
	errStep.ErrorMessage = ptr("Runner crashed")
	manualFailed := RunStep{ID: uuid.New(), Position: 1, StepID: "m1", Action: "manual", Summary: "manual",
		Description: "Open the invoice list", Expected: "Invoices are listed", Status: "failed",
		ActualResult: ptr("Empty page <blank>"), Details: json.RawMessage("null")}
	manualOK := RunStep{ID: uuid.New(), Position: 2, StepID: "m2", Action: "manual", Summary: "manual",
		Description: "Download the PDF", Status: "passed", ActualResult: ptr("Downloaded"), Details: json.RawMessage("null")}
	blocked := RunStep{ID: uuid.New(), Position: 1, StepID: "b1", Action: "manual", Summary: "manual",
		Description: "Sign the delivery", Status: "blocked", ActualResult: ptr("Printer offline"), Details: json.RawMessage("null")}
	tester := auth.UserRef{Name: "Sari & Co"}

	return Run{
		RunSummary: RunSummary{
			Key: "SHOP-R12", ProjectKey: "SHOP", Kind: KindFlow, Status: StatusFailed, Trigger: TriggerAPI,
			Target:      Target{Key: "SHOP-F2", Title: `Checkout "happy" path`},
			Environment: &EnvironmentRef{Name: "Staging"}, TriggeredBy: auth.UserRef{Name: "CI bot"},
			QueuedAt: started.Add(-time.Second), StartedAt: &started, FinishedAt: &finished, DurationMS: ptr(int64(12345)),
		},
		Options:      json.RawMessage(`{"browser":"firefox"}`),
		ErrorMessage: nil,
		Cases: []RunCase{
			{Position: 1, TestCaseKey: "SHOP-T1", Title: "Login", Execution: ExecutionAutomated, Status: "passed", DurationMS: ptr(int64(1500)), Steps: []RunStep{login}},
			{Position: 2, TestCaseKey: "SHOP-T3", Title: "Cart <total>", Execution: ExecutionAutomated, Status: "failed", DurationMS: ptr(int64(5200)), Steps: []RunStep{login, failed}},
			{Position: 3, TestCaseKey: "SHOP-T7", Title: "Invoice", Execution: ExecutionManual, Status: "failed", ExecutedBy: &tester, Steps: []RunStep{manualFailed, manualOK}},
			{Position: 4, TestCaseKey: "SHOP-T8", Title: "Delivery", Execution: ExecutionManual, Status: "blocked", Steps: []RunStep{blocked}},
			{Position: 5, TestCaseKey: "SHOP-T9", Title: "Payment", Execution: ExecutionAutomated, Status: "error", Steps: []RunStep{errStep}},
			{Position: 6, TestCaseKey: "SHOP-T1", Title: "Login", Execution: ExecutionAutomated, Status: "skipped", Steps: []RunStep{step(1, "s1", "fill", "fill", "skipped", 0)}},
		},
	}
}

type parsedProblem struct {
	Message string `xml:"message,attr"`
	Type    string `xml:"type,attr"`
	Text    string `xml:",chardata"`
}

type parsedJUnit struct {
	XMLName  xml.Name `xml:"testsuites"`
	Tests    int      `xml:"tests,attr"`
	Failures int      `xml:"failures,attr"`
	Errors   int      `xml:"errors,attr"`
	Skipped  int      `xml:"skipped,attr"`
	Suites   []struct {
		Name       string `xml:"name,attr"`
		ID         string `xml:"id,attr"`
		Tests      int    `xml:"tests,attr"`
		Failures   int    `xml:"failures,attr"`
		Errors     int    `xml:"errors,attr"`
		Skipped    int    `xml:"skipped,attr"`
		Time       string `xml:"time,attr"`
		Timestamp  string `xml:"timestamp,attr"`
		Properties []struct {
			Name  string `xml:"name,attr"`
			Value string `xml:"value,attr"`
		} `xml:"properties>property"`
		Cases []struct {
			ClassName string         `xml:"classname,attr"`
			Name      string         `xml:"name,attr"`
			Time      string         `xml:"time,attr"`
			Failure   *parsedProblem `xml:"failure"`
			Error     *parsedProblem `xml:"error"`
			Skipped   *struct {
				Message string `xml:"message,attr"`
			} `xml:"skipped"`
			SystemOut string `xml:"system-out"`
		} `xml:"testcase"`
		SystemErr string `xml:"system-err"`
	} `xml:"testsuite"`
}

func parseJUnit(t *testing.T, data []byte) parsedJUnit {
	t.Helper()
	// Well-formedness: walk every token with a strict decoder.
	dec := xml.NewDecoder(bytes.NewReader(data))
	dec.Strict = true
	for {
		_, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("invalid XML: %v\n%s", err, data)
		}
	}
	var p parsedJUnit
	if err := xml.Unmarshal(data, &p); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return p
}

func TestJUnitXML(t *testing.T) {
	data, err := JUnitXML(junitFixture())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte(`<?xml version="1.0" encoding="UTF-8"?>`)) {
		t.Fatalf("missing XML header: %.60s", data)
	}
	p := parseJUnit(t, data)
	if p.Tests != 6 || p.Failures != 3 || p.Errors != 1 || p.Skipped != 1 || len(p.Suites) != 1 {
		t.Fatalf("root counts: %+v", p)
	}
	s := p.Suites[0]
	if s.Name != `SHOP-F2 Checkout "happy" path` || s.ID != "SHOP-R12" || s.Tests != 6 || s.Failures != 3 || s.Errors != 1 || s.Skipped != 1 {
		t.Fatalf("suite: %+v", s)
	}
	if s.Time != "12.345" || s.Timestamp != "2026-11-04T02:30:15" {
		t.Fatalf("time/timestamp: %q %q", s.Time, s.Timestamp)
	}
	props := map[string]string{}
	for _, pr := range s.Properties {
		props[pr.Name] = pr.Value
	}
	if props["qatlas.status"] != "failed" || props["qatlas.environment"] != "Staging" || props["qatlas.browser"] != "firefox" || props["qatlas.trigger"] != "api" {
		t.Fatalf("properties: %v", props)
	}

	c := s.Cases
	if len(c) != 6 {
		t.Fatalf("cases: %d", len(c))
	}
	if c[0].ClassName != "SHOP" || c[0].Name != "SHOP-T1 Login [#1]" || c[0].Time != "1.500" || c[0].Failure != nil || c[0].Skipped != nil {
		t.Fatalf("passed case: %+v", c[0])
	}
	if c[5].Name != "SHOP-T1 Login [#6]" || c[5].Skipped == nil {
		t.Fatalf("skipped case: %+v", c[5])
	}
	// Failed automated case: summary + error (ANSI and NUL stripped) + expected/actual.
	f := c[1].Failure
	if c[1].Name != "SHOP-T3 Cart <total>" || f == nil || f.Type != "failed" {
		t.Fatalf("failed case: %+v", c[1])
	}
	wantMsg := `Step 2: text "Total" contains "<Rp 10.000>" — Expected text to contain "<Rp 10.000>" & more`
	if f.Message != wantMsg {
		t.Fatalf("failure message:\n got %q\nwant %q", f.Message, wantMsg)
	}
	for _, want := range []string{"Step 2 (s2) failed:", "Expected: <Rp 10.000>", `Actual: Rp 9.000 & "tax"`} {
		if !strings.Contains(f.Text, want) {
			t.Errorf("failure text lacks %q:\n%s", want, f.Text)
		}
	}
	if strings.Contains(string(data), "\x1b") || strings.Contains(string(data), "\x00") {
		t.Fatal("control characters leaked into the XML")
	}
	if !strings.Contains(c[1].SystemOut, "1. [passed] fill label=Password with •••• (120 ms)") || !strings.Contains(c[1].SystemOut, "2. [failed]") {
		t.Fatalf("system-out: %q", c[1].SystemOut)
	}
	// Manual cases: tester status + actual results.
	mf := c[2].Failure
	if mf == nil || mf.Message != "Step 1: Open the invoice list — Empty page <blank>" || !strings.Contains(mf.Text, "Expected: Invoices are listed") ||
		!strings.Contains(mf.Text, "Actual: Empty page <blank>") {
		t.Fatalf("manual failure: %+v", mf)
	}
	for _, want := range []string{"Manual test case, executed by Sari & Co", "Actual result: Downloaded", "1. [failed] Open the invoice list"} {
		if !strings.Contains(c[2].SystemOut, want) {
			t.Errorf("manual system-out lacks %q:\n%s", want, c[2].SystemOut)
		}
	}
	if b := c[3].Failure; b == nil || b.Type != "blocked" || !strings.HasPrefix(b.Message, "Blocked: Step 1: Sign the delivery") {
		t.Fatalf("blocked case: %+v", c[3])
	}
	if e := c[4].Error; e == nil || e.Type != "error" || !strings.Contains(e.Message, "Runner crashed") || c[4].Failure != nil {
		t.Fatalf("error case: %+v", c[4])
	}
	// Escaping happened in the raw document.
	for _, want := range []string{"Cart &lt;total&gt;", "Sari &amp; Co"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("raw XML lacks %q", want)
		}
	}
}

func TestJUnitXMLRunError(t *testing.T) {
	run := junitFixture()
	run.Status = StatusError
	run.ErrorMessage = ptr("The worker restarted while the run was executing")
	run.Options = json.RawMessage(`{}`)
	run.StartedAt, run.DurationMS = nil, nil
	run.Cases = []RunCase{
		{Position: 1, TestCaseKey: "SHOP-T1", Title: "Login", Execution: ExecutionAutomated, Status: "error"},
		{Position: 2, TestCaseKey: "SHOP-T2", Title: "Cart", Execution: ExecutionAutomated, Status: "pending"},
	}
	data, err := JUnitXML(run)
	if err != nil {
		t.Fatal(err)
	}
	p := parseJUnit(t, data)
	s := p.Suites[0]
	if s.Errors != 1 || s.Skipped != 1 || s.Failures != 0 || s.Time != "0.000" || s.Timestamp != "2026-11-04T02:30:14" {
		t.Fatalf("suite: %+v", s)
	}
	if e := s.Cases[0].Error; e == nil || e.Message != "The worker restarted while the run was executing" {
		t.Fatalf("error without step: %+v", s.Cases[0])
	}
	if sk := s.Cases[1].Skipped; sk == nil || sk.Message != "Not executed (run error)" {
		t.Fatalf("pending case: %+v", s.Cases[1])
	}
	if s.SystemErr != "The worker restarted while the run was executing" {
		t.Fatalf("system-err: %q", s.SystemErr)
	}
}

func TestJUnitTruncatesLongMessages(t *testing.T) {
	run := junitFixture()
	run.Cases = run.Cases[1:2]
	long := strings.Repeat("x", 5000)
	run.Cases[0].Steps[1].ErrorMessage = &long
	data, err := JUnitXML(run)
	if err != nil {
		t.Fatal(err)
	}
	f := parseJUnit(t, data).Suites[0].Cases[0].Failure
	if n := len([]rune(f.Message)); n > junitMessageChars+1 {
		t.Fatalf("message length %d", n)
	}
	if strings.Contains(f.Text, strings.Repeat("x", junitTextChars+1)) || !strings.Contains(f.Text, strings.Repeat("x", junitTextChars)+"…") {
		t.Fatalf("text not truncated")
	}
}
