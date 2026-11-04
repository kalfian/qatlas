package server

import (
	"encoding/xml"
	"net/http"
	"strings"
	"testing"

	"github.com/kalfian/qatlas/backend/internal/auth"
)

type junitDoc struct {
	Tests    int `xml:"tests,attr"`
	Failures int `xml:"failures,attr"`
	Errors   int `xml:"errors,attr"`
	Skipped  int `xml:"skipped,attr"`
	Suites   []struct {
		Name  string `xml:"name,attr"`
		ID    string `xml:"id,attr"`
		Cases []struct {
			ClassName string `xml:"classname,attr"`
			Name      string `xml:"name,attr"`
			Failure   *struct {
				Message string `xml:"message,attr"`
				Text    string `xml:",chardata"`
			} `xml:"failure"`
			Skipped   *struct{} `xml:"skipped"`
			SystemOut string    `xml:"system-out"`
		} `xml:"testcase"`
	} `xml:"testsuite"`
}

func TestRunJUnitExport(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	// Not final yet → 409 conflict with a clear message.
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T1"})
	r := f.cV.expect("GET", "/api/v1/runs/"+run.Key+"/junit.xml", nil, 409, nil)
	if r.errCode(t) != "conflict" || !strings.Contains(string(r.body), "available once the run has finished") {
		t.Fatalf("not final: %s", r.body)
	}

	// Simulate the worker: step 2 (the masked secret fill) fails, step 3 was disabled → skipped.
	rnExec(t, e, `UPDATE run_steps SET status = 'passed', duration_ms = 120 WHERE run_case_id = $1 AND position = 1`, run.Cases[0].ID)
	rnExec(t, e, `UPDATE run_steps SET status = 'failed', duration_ms = 10003,
		error_message = 'Timeout 10000ms exceeded filling "••••" <input>',
		details = '{"expected":"visible","actual":"hidden"}' WHERE run_case_id = $1 AND position = 2`, run.Cases[0].ID)
	rnExec(t, e, `UPDATE run_steps SET status = 'skipped' WHERE run_case_id = $1 AND position = 3`, run.Cases[0].ID)
	rnExec(t, e, `UPDATE run_cases SET status = 'failed', started_at = now() - interval '11 seconds', finished_at = now(), duration_ms = 10500 WHERE id = $1`, run.Cases[0].ID)
	rnExec(t, e, `UPDATE runs SET status = 'failed', started_at = now() - interval '12 seconds', finished_at = now() WHERE id = $1`, run.ID)

	path := "/api/v1/runs/" + strings.ToLower(run.Key) + "/junit.xml"
	r = f.cV.expect("GET", path, nil, 200, nil)
	if ct := r.header.Get("Content-Type"); !strings.HasPrefix(ct, "application/xml") {
		t.Fatalf("content-type %q", ct)
	}
	if cd := r.header.Get("Content-Disposition"); cd != `attachment; filename="SHOP-R1.junit.xml"` {
		t.Fatalf("content-disposition %q", cd)
	}
	body := string(r.body)
	if strings.Contains(body, rnSecret) {
		t.Fatal("secret value in JUnit XML")
	}
	var doc junitDoc
	if err := xml.Unmarshal(r.body, &doc); err != nil {
		t.Fatalf("xml: %v\n%s", err, body)
	}
	if doc.Tests != 1 || doc.Failures != 1 || doc.Errors != 0 || doc.Skipped != 0 || len(doc.Suites) != 1 {
		t.Fatalf("counts: %+v", doc)
	}
	s := doc.Suites[0]
	if s.Name != "SHOP-T1 Login works" || s.ID != "SHOP-R1" || len(s.Cases) != 1 {
		t.Fatalf("suite: %+v", s)
	}
	c := s.Cases[0]
	if c.ClassName != "SHOP" || c.Name != "SHOP-T1 Login works" || c.Failure == nil ||
		!strings.HasPrefix(c.Failure.Message, `Step 2: Fill label=Password with "••••"`) ||
		!strings.Contains(c.Failure.Text, `Timeout 10000ms exceeded filling "••••" <input>`) ||
		!strings.Contains(c.Failure.Text, "Expected: visible") || !strings.Contains(c.Failure.Text, "Actual: hidden") {
		t.Fatalf("case: %+v", c)
	}
	if !strings.Contains(c.SystemOut, "1. [passed] Open https://staging.example/login (120 ms)") || !strings.Contains(c.SystemOut, "3. [skipped]") {
		t.Fatalf("system-out: %q", c.SystemOut)
	}

	// Bearer tokens: read scope is enough; a token without read is refused.
	var ro, wo auth.CreatedToken
	f.cE.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "CI read", "scopes": []string{"read"}}, 201, &ro)
	f.cE.expect("POST", "/api/v1/me/tokens", map[string]any{"name": "Write only", "scopes": []string{"write"}}, 201, &wo)
	if rb := e.bearer(ro.Secret).expect("GET", path, nil, 200, nil); string(rb.body) != body {
		t.Fatal("bearer and session exports differ")
	}
	e.bearer(wo.Secret).expect("GET", path, nil, 403, nil)

	// Access: outsiders get 404, anonymous 401, unknown runs 404.
	f.cOutside.expect("GET", path, nil, 404, nil)
	e.browser().expect("GET", path, nil, 401, nil)
	f.cV.expect("GET", "/api/v1/runs/SHOP-R99/junit.xml", nil, 404, nil)

	// Manual run: the tester's statuses and actual results are exported.
	manual := f.create(f.cE, map[string]any{"test_case": "SHOP-T2"})
	f.cV.expect("GET", "/api/v1/runs/"+manual.Key+"/junit.xml", nil, 409, nil) // awaiting_manual
	f.cE.expect("PUT", stepPath(manual, 0, 0), map[string]any{"status": "passed", "actual_result": "List is there"}, 200, nil)
	f.cE.expect("PUT", stepPath(manual, 0, 1), map[string]any{"status": "failed", "actual_result": "PDF is empty"}, 200, nil)
	f.cE.expect("POST", casePath(manual, 0, "complete-manual"), nil, 200, nil)
	r = f.cE.expect("GET", "/api/v1/runs/"+manual.Key+"/junit.xml", nil, 200, nil)
	doc = junitDoc{}
	if err := xml.Unmarshal(r.body, &doc); err != nil {
		t.Fatal(err)
	}
	mc := doc.Suites[0].Cases[0]
	if doc.Failures != 1 || mc.Failure == nil || mc.Failure.Message != "Step 2: Download the PDF — PDF is empty" ||
		!strings.Contains(mc.SystemOut, "Manual test case, executed by Eddie") || !strings.Contains(mc.SystemOut, "Actual result: List is there") {
		t.Fatalf("manual export: %+v\n%s", doc, r.body)
	}

	// Cancelled runs are final too: every case skipped.
	queued := f.create(f.cE, map[string]any{"test_case": "SHOP-T3"})
	f.cE.expect("POST", "/api/v1/runs/"+queued.Key+"/cancel", nil, 200, nil)
	r = f.cE.expect("GET", "/api/v1/runs/"+queued.Key+"/junit.xml", nil, 200, nil)
	doc = junitDoc{}
	if err := xml.Unmarshal(r.body, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Tests != 1 || doc.Skipped != 1 || doc.Suites[0].Cases[0].Skipped == nil {
		t.Fatalf("cancelled export: %s", r.body)
	}
	if r.status != http.StatusOK {
		t.Fatal(r.status)
	}
}
