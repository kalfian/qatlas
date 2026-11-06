package server

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/devices"
	"github.com/kalfian/qatlas/backend/internal/projects"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// Responsive testing (docs/14-responsive-testing.md): runs on several devices.

type runOptionsDTO struct {
	Viewport projects.Viewport `json:"viewport"`
	Devices  []devices.Device  `json:"devices"`
	Browser  string            `json:"browser"`
}

func optionsOf(t *testing.T, run runs.Run) runOptionsDTO {
	t.Helper()
	var o runOptionsDTO
	if err := json.Unmarshal(run.Options, &o); err != nil {
		t.Fatalf("options %s: %v", run.Options, err)
	}
	return o
}

func deviceIDs(list []devices.Device) string {
	ids := make([]string, len(list))
	for i, d := range list {
		ids[i] = d.ID
		if d.ID == devices.CustomID {
			ids[i] = fmt.Sprintf("custom:%dx%d:%s", d.Width, d.Height, d.Category)
		}
	}
	return strings.Join(ids, ",")
}

// caseLayout renders "position:device_index:key" for every case.
func caseLayout(run runs.Run) string {
	var parts []string
	for _, c := range run.Cases {
		parts = append(parts, fmt.Sprintf("%d:%d:%s", c.Position, c.DeviceIndex, c.TestCaseKey))
	}
	return strings.Join(parts, " ")
}

func stepByID(t *testing.T, c runs.RunCase, id string) runs.RunStep {
	t.Helper()
	for _, s := range c.Steps {
		if s.StepID == id {
			return s
		}
	}
	t.Fatalf("case %s has no step %s", c.TestCaseKey, id)
	return runs.RunStep{}
}

func (f *rnFixture) responsiveCase(seq int) uuid.UUID {
	return f.testCase(seq, "Responsive nav", "automated", []map[string]any{
		{"id": "r1", "action": "goto", "url": "{{env.BASE_URL}}/"},
		{"id": "r2", "action": "click", "selector": "role=button[name='Menu']", "only_on": []string{"mobile"}},
		{"id": "r3", "action": "click", "selector": "role=link[name='Shop']", "only_on": []string{"desktop", "tablet"}, "enabled": false},
		{"id": "r4", "action": "expect_no_horizontal_scroll", "selector": "testid=cart", "tolerance_px": 2},
		{"id": "r5", "action": "set_viewport", "width": 768, "height": 1024, "only_on": []string{"desktop"}},
	})
}

func TestRunDevicesFlow(t *testing.T) {
	f := rnSetup(t)
	e := f.e
	resp := f.responsiveCase(6)
	f.flow(1, "Responsive smoke", true, rnItem{tc: f.tcAuto}, rnItem{tc: resp, cont: true})

	run := f.create(f.cE, map[string]any{"flow": "SHOP-F1", "options": map[string]any{
		"viewport": map[string]any{"width": 1920, "height": 1080}, // devices win over viewport
		"devices":  []map[string]any{{"id": "desktop"}, {"id": "iphone-15"}, {"id": "custom", "width": 800, "height": 1280, "label": "Kiosk"}},
	}})
	o := optionsOf(t, run)
	if deviceIDs(o.Devices) != "desktop,iphone-15,custom:800x1280:tablet" || o.Viewport != (projects.Viewport{Width: 1280, Height: 720}) {
		t.Fatalf("options: %s", run.Options)
	}
	if o.Devices[2].Label != "Kiosk" || o.Devices[2].DeviceScaleFactor != 1 || o.Devices[2].IsMobile || !o.Devices[1].IsMobile || o.Devices[1].DeviceScaleFactor != 3 {
		t.Fatalf("resolved devices: %+v", o.Devices)
	}
	if strings.Contains(string(run.Options), "playwright") {
		t.Fatalf("playwright must not reach the API: %s", run.Options)
	}
	if got := caseLayout(run); got != "1:0:SHOP-T1 2:0:SHOP-T6 3:1:SHOP-T1 4:1:SHOP-T6 5:2:SHOP-T1 6:2:SHOP-T6" {
		t.Fatalf("cases: %s", got)
	}
	if run.Summary.Cases.Total != 6 || run.Status != runs.StatusQueued || len(f.enq.calls()) != 1 {
		t.Fatalf("summary/status: %+v %s", run.Summary, run.Status)
	}
	if n := e.count(`SELECT count(*) FROM run_cases WHERE run_id = $1 AND continue_on_failure`, run.ID); n != 3 {
		t.Fatalf("continue_on_failure copied to %d cases, want one per device", n)
	}

	// only_on snapshot: not applicable → skipped up front (enabled = false); the step's own
	// enabled flag still applies on the devices where it is applicable.
	type want struct{ r2, r3, r5 string }
	for i, w := range map[int]want{1: {"skipped", "pending", "pending"}, 3: {"pending", "skipped", "skipped"}, 5: {"skipped", "pending", "skipped"}} {
		c := run.Cases[i]
		got := want{stepByID(t, c, "r2").Status, stepByID(t, c, "r3").Status, stepByID(t, c, "r5").Status}
		if got != w {
			t.Errorf("case %d (device %d): %+v, want %+v", c.Position, c.DeviceIndex, got, w)
		}
	}
	c := run.Cases[1]
	if !reflect.DeepEqual(stepByID(t, c, "r2").OnlyOn, []string{"mobile"}) || stepByID(t, c, "r1").OnlyOn != nil ||
		!reflect.DeepEqual(stepByID(t, c, "r3").OnlyOn, []string{"desktop", "tablet"}) {
		t.Fatalf("only_on snapshot: %+v", c.Steps)
	}
	if stepByID(t, c, "r4").Summary != "Expect no horizontal scroll in testid=cart" || stepByID(t, c, "r5").Summary != "Set viewport 768×1024" {
		t.Fatalf("summaries: %+v", c.Steps)
	}
	// enabled column: r3 is disabled everywhere (own flag), r2 only where it does not apply.
	if n := e.count(`SELECT count(*) FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id
		WHERE c.run_id = $1 AND s.step_id = 'r2' AND s.enabled`, run.ID); n != 1 {
		t.Fatalf("r2 enabled on %d devices, want 1 (iPhone)", n)
	}
	if n := e.count(`SELECT count(*) FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id
		WHERE c.run_id = $1 AND s.step_id = 'r3' AND s.enabled`, run.ID); n != 0 {
		t.Fatalf("r3 enabled on %d devices", n)
	}
	// The raw JSON has device_index and only_on (null when absent).
	r := f.cE.expect("GET", "/api/v1/runs/"+run.Key, nil, 200, nil)
	if !strings.Contains(string(r.body), `"device_index":2`) || !strings.Contains(string(r.body), `"only_on":null`) || !strings.Contains(string(r.body), `"only_on":["mobile"]`) {
		t.Fatalf("raw run JSON: %.600s", r.body)
	}
	// The snapshot has one entry per run case with its device index.
	if n := e.count(`SELECT jsonb_array_length(snapshot->'cases') FROM runs WHERE id = $1`, run.ID); n != 6 {
		t.Fatalf("snapshot cases: %d", n)
	}
	if n := e.count(`SELECT (snapshot->'cases'->5->>'device_index')::int FROM runs WHERE id = $1`, run.ID); n != 2 {
		t.Fatalf("snapshot device_index: %d", n)
	}

	// Rerun keeps the devices.
	var re runs.Run
	f.cE.expect("POST", "/api/v1/runs/"+run.Key+"/rerun", map[string]any{}, 202, &re)
	if deviceIDs(optionsOf(t, re).Devices) != "desktop,iphone-15,custom:800x1280:tablet" || len(re.Cases) != 6 {
		t.Fatalf("rerun: %s / %s", re.Options, caseLayout(re))
	}

	// JUnit names carry the device label.
	rnExec(t, e, `UPDATE run_cases SET status = 'passed' WHERE run_id = $1`, run.ID)
	rnExec(t, e, `UPDATE runs SET status = 'passed', started_at = now(), finished_at = now() WHERE id = $1`, run.ID)
	x := f.cE.expect("GET", "/api/v1/runs/"+run.Key+"/junit.xml", nil, 200, nil)
	for _, name := range []string{`name="SHOP-T1 Login works [Desktop]"`, `name="SHOP-T6 Responsive nav [iPhone 15]"`, `name="SHOP-T6 Responsive nav [Kiosk]"`} {
		if !strings.Contains(string(x.body), name) {
			t.Fatalf("junit misses %s:\n%s", name, x.body)
		}
	}
}

func TestRunDevicesOptions(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	// Test case run on two devices: one case per device.
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T3", "options": map[string]any{"devices": []map[string]any{{"id": "pixel-7"}, {"id": "ipad-mini"}}}})
	if caseLayout(run) != "1:0:SHOP-T3 2:1:SHOP-T3" || optionsOf(t, run).Viewport != (projects.Viewport{Width: 412, Height: 839}) {
		t.Fatalf("test case run: %s %s", caseLayout(run), run.Options)
	}

	// No options → project defaults (desktop 1280×720).
	run = f.create(f.cE, map[string]any{"test_case": "SHOP-T3"})
	if o := optionsOf(t, run); deviceIDs(o.Devices) != "desktop" || caseLayout(run) != "1:0:SHOP-T3" {
		t.Fatalf("default: %s", run.Options)
	}
	// A lone viewport (older clients) → one device: an exact-size non-mobile preset or custom.
	for vp, want := range map[[2]int]string{{1440, 900}: "laptop", {390, 844}: "custom:390x844:mobile", {1024, 768}: "custom:1024x768:desktop"} {
		run = f.create(f.cE, map[string]any{"test_case": "SHOP-T3", "options": map[string]any{"viewport": map[string]any{"width": vp[0], "height": vp[1]}}})
		if o := optionsOf(t, run); deviceIDs(o.Devices) != want || o.Viewport != (projects.Viewport{Width: vp[0], Height: vp[1]}) {
			t.Fatalf("viewport %v: %s", vp, run.Options)
		}
	}

	seven := make([]map[string]any, 7)
	for i := range seven {
		seven[i] = map[string]any{"id": "custom", "width": 400 + i, "height": 800}
	}
	long := strings.Repeat("x", 41)
	for _, c := range []struct {
		devices any
		paths   string
	}{
		{[]any{}, "options.devices"},
		{seven, "options.devices"},
		{"iphone-15", "options.devices"},
		{[]map[string]any{{"id": "nokia"}}, "options.devices[0].id"},
		{[]map[string]any{{"id": "desktop"}, {"id": "custom", "height": 800}}, "options.devices[1].width"},
		{[]map[string]any{{"id": "custom", "width": 4000, "height": 100}}, "options.devices[0].width,options.devices[0].height"},
		{[]map[string]any{{"id": "custom", "width": 400, "height": 800, "category": "watch", "label": long}}, "options.devices[0].category,options.devices[0].label"},
		{[]map[string]any{{"id": "iphone-15"}, {"id": "iphone-15"}}, "options.devices[1]"},
		{[]map[string]any{{"id": "custom", "width": 390, "height": 844}, {"id": "custom", "width": 390, "height": 844, "label": "Same size"}}, "options.devices[1]"},
	} {
		r := f.cE.expect("POST", "/api/v1/projects/SHOP/runs", map[string]any{"test_case": "SHOP-T3", "options": map[string]any{"devices": c.devices}}, 422, nil)
		var body apiErr
		r.decode(t, &body)
		var paths []string
		for _, d := range body.Error.Details {
			paths = append(paths, d.Path)
		}
		if body.Error.Code != "validation_failed" || strings.Join(paths, ",") != c.paths {
			t.Errorf("devices %v: %s", c.devices, r.body)
		}
	}
	if n := e.count(`SELECT count(*) FROM runs WHERE project_id = $1`, f.shop); n != 5 {
		t.Fatalf("rejected runs must not be created: %d runs", n)
	}

	// Legacy run options (stored before devices existed) → devices synthesized from the viewport.
	rnExec(t, e, `UPDATE runs SET options = (options - 'devices') || '{"viewport":{"width":1920,"height":1080}}' WHERE id = $1`, run.ID)
	got := f.get(f.cE, run.Key)
	if o := optionsOf(t, got); deviceIDs(o.Devices) != "desktop-fhd" || got.Cases[0].DeviceIndex != 0 {
		t.Fatalf("legacy run: %s", got.Options)
	}
}

func TestProjectDefaultDevices(t *testing.T) {
	f := rnSetup(t)
	e := f.e

	var p projects.Project
	f.cM.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"default_run_options": map[string]any{
		"devices": []map[string]any{{"id": "ipad-mini"}, {"id": "custom", "width": 390, "height": 844, "label": "Phone"}}, "video": "always"}}, 200, &p)
	o := p.DefaultRunOptions
	if deviceIDs(o.Devices) != "ipad-mini,custom:390x844:mobile" || o.Viewport != (projects.Viewport{Width: 768, Height: 1024}) || o.Video != "always" {
		t.Fatalf("defaults: %+v", o)
	}
	var got projects.Project
	f.cM.expect("GET", "/api/v1/projects/SHOP", nil, 200, &got)
	if !got.DefaultRunOptions.Equal(o) {
		t.Fatalf("round trip: %+v", got.DefaultRunOptions)
	}
	// Sending the resolved devices back (as the settings form does) changes nothing.
	audits := e.count(`SELECT count(*) FROM audit_logs WHERE action = 'project.update'`)
	f.cM.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"default_run_options": map[string]any{"devices": o.Devices}}, 200, &got)
	if !got.DefaultRunOptions.Equal(o) || e.count(`SELECT count(*) FROM audit_logs WHERE action = 'project.update'`) != audits {
		t.Fatalf("resolved devices as input: %+v", got.DefaultRunOptions)
	}

	// A run without options uses the project's devices.
	run := f.create(f.cE, map[string]any{"test_case": "SHOP-T3"})
	if deviceIDs(optionsOf(t, run).Devices) != "ipad-mini,custom:390x844:mobile" || caseLayout(run) != "1:0:SHOP-T3 2:1:SHOP-T3" {
		t.Fatalf("run from defaults: %s", run.Options)
	}
	// A lone viewport in the run overrides the project's devices.
	run = f.create(f.cE, map[string]any{"test_case": "SHOP-T3", "options": map[string]any{"viewport": map[string]any{"width": 1280, "height": 720}}})
	if deviceIDs(optionsOf(t, run).Devices) != "desktop" || len(run.Cases) != 1 {
		t.Fatalf("viewport override: %s", run.Options)
	}

	// Invalid devices → 400 with default_run_options paths, nothing changes.
	r := f.cM.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"default_run_options": map[string]any{"devices": []map[string]any{{"id": "nope"}}}}, 400, nil)
	var body apiErr
	r.decode(t, &body)
	if len(body.Error.Details) != 1 || body.Error.Details[0].Path != "default_run_options.devices[0].id" {
		t.Fatalf("bad devices: %s", r.body)
	}
	// A lone viewport replaces the devices (older clients).
	f.cM.expect("PATCH", "/api/v1/projects/SHOP", map[string]any{"default_run_options": map[string]any{"viewport": map[string]any{"width": 1440, "height": 900}}}, 200, &got)
	if deviceIDs(got.DefaultRunOptions.Devices) != "laptop" {
		t.Fatalf("viewport patch: %+v", got.DefaultRunOptions.Devices)
	}

	// Defaults stored before devices existed are read through the viewport (no backfill).
	rnExec(t, e, `UPDATE projects SET default_run_options = '{"browser":"firefox","viewport":{"width":1920,"height":1080}}' WHERE id = $1`, f.shop)
	f.cM.expect("GET", "/api/v1/projects/SHOP", nil, 200, &got)
	if deviceIDs(got.DefaultRunOptions.Devices) != "desktop-fhd" || got.DefaultRunOptions.Browser != "firefox" {
		t.Fatalf("legacy defaults: %+v", got.DefaultRunOptions)
	}
	run = f.create(f.cE, map[string]any{"test_case": "SHOP-T3"})
	if o := optionsOf(t, run); deviceIDs(o.Devices) != "desktop-fhd" || o.Browser != "firefox" {
		t.Fatalf("run from legacy defaults: %s", run.Options)
	}
}

// TestRunDevicesManualStopOnFailure: complete-manual (runs.Continue) scopes
// stop_on_failure to the device; manual cases are repeated per device and park
// at their own position.
func TestRunDevicesManualStopOnFailure(t *testing.T) {
	f := rnSetup(t)
	f.flow(1, "Manual first", true, rnItem{tc: f.tcManual}, rnItem{tc: f.tcAuto})
	run := f.create(f.cE, map[string]any{"flow": "SHOP-F1", "options": map[string]any{"devices": []map[string]any{{"id": "desktop"}, {"id": "iphone-15"}}}})
	if run.Status != runs.StatusAwaitingManual || run.ResumePosition == nil || *run.ResumePosition != 1 || caseLayout(run) != "1:0:SHOP-T2 2:0:SHOP-T1 3:1:SHOP-T2 4:1:SHOP-T1" {
		t.Fatalf("created: %s %v %s", run.Status, run.ResumePosition, caseLayout(run))
	}
	// Device 0: the manual case fails → the rest of device 0 is skipped, device 1 continues.
	f.cE.expect("PUT", stepPath(run, 0, 0), map[string]any{"status": "failed"}, 200, nil)
	f.cE.expect("PUT", stepPath(run, 0, 1), map[string]any{"status": "passed"}, 200, nil)
	var got runs.Run
	f.cE.expect("POST", casePath(run, 0, "complete-manual"), nil, 200, &got)
	if got.Status != runs.StatusAwaitingManual || got.ResumePosition == nil || *got.ResumePosition != 3 {
		t.Fatalf("after device 0: %s resume %v", got.Status, got.ResumePosition)
	}
	if got.Cases[0].Status != "failed" || got.Cases[1].Status != "skipped" || got.Cases[2].Status != "pending" || got.Cases[3].Status != "pending" {
		t.Fatalf("statuses after device 0: %s %s %s %s", got.Cases[0].Status, got.Cases[1].Status, got.Cases[2].Status, got.Cases[3].Status)
	}
	// Device 1: the manual case passes → the automated case is queued for the worker.
	f.cE.expect("PUT", stepPath(got, 2, 0), map[string]any{"status": "passed"}, 200, nil)
	f.cE.expect("PUT", stepPath(got, 2, 1), map[string]any{"status": "passed"}, 200, nil)
	f.cE.expect("POST", casePath(got, 2, "complete-manual"), nil, 200, &got)
	if got.Status != runs.StatusQueued || got.ResumePosition == nil || *got.ResumePosition != 4 || got.Cases[3].Status != "pending" || len(f.enq.calls()) != 1 {
		t.Fatalf("after device 1 manual: %s resume %v case4 %s enq %d", got.Status, got.ResumePosition, got.Cases[3].Status, len(f.enq.calls()))
	}
}

func TestMCPDevices(t *testing.T) {
	f := mcpSetup(t)
	e := f.e
	cs := f.connect(f.full)

	descs := map[string]string{}
	for tool, err := range cs.Tools(e.ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		descs[tool.Name] = tool.Description
	}
	for _, name := range []string{"run_test_case", "run_flow"} {
		if !strings.Contains(descs[name], "iphone-15") || !strings.Contains(descs[name], "galaxy-s9plus") || !strings.Contains(descs[name], "custom:{width}x{height}") {
			t.Fatalf("%s description lacks the preset ids: %s", name, descs[name])
		}
	}

	ok(t, cs, "create_test_case", map[string]any{"project": "SHOP", "definition": map[string]any{"title": "Responsive home", "steps": []map[string]any{
		{"id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/"},
		{"id": "s2", "action": "click", "selector": "role=button[name='Menu']", "only_on": []string{"mobile"}},
		{"id": "s3", "action": "expect_no_horizontal_scroll"},
	}}}, nil)

	var started struct {
		RunKey  string `json:"run_key"`
		Status  string
		Cases   int
		Devices []string
	}
	ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "options": map[string]any{"devices": []string{"desktop", "iphone-15", "Custom:390x844"}}}, &started)
	if started.Status != "queued" || started.Cases != 3 || strings.Join(started.Devices, "|") != "Desktop · 1280×720|iPhone 15 · 393×659|390×844" {
		t.Fatalf("run_test_case with devices: %+v", started)
	}
	run := f.runByKey(started.RunKey)
	if caseLayout(run) != "1:0:SHOP-T1 2:1:SHOP-T1 3:2:SHOP-T1" || deviceIDs(optionsOf(t, run).Devices) != "desktop,iphone-15,custom:390x844:mobile" {
		t.Fatalf("run: %s %s", caseLayout(run), run.Options)
	}

	for _, c := range []struct {
		devices []string
		path    string
	}{
		{[]string{"nokia-3310"}, "options.devices[0].id"},
		{[]string{"desktop", "custom:wide"}, "options.devices[1].id"},
		{[]string{"custom:100x100"}, "options.devices[0].width"},
		{[]string{"pixel-7", "pixel-7"}, "options.devices[1]"},
	} {
		er := fails(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "options": map[string]any{"devices": c.devices}})
		if er.Error.Code != "validation_failed" || len(er.Error.Details) == 0 || er.Error.Details[0].Path != c.path {
			t.Errorf("devices %v: %+v", c.devices, er)
		}
	}
	// The schema caps the list at 6.
	if res, _ := call(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "options": map[string]any{"devices": []string{"a", "b", "c", "d", "e", "f", "g"}}}); !res.IsError {
		t.Fatal("7 devices accepted")
	}
	// The legacy viewport input still works (one device).
	var legacy struct {
		RunKey  string `json:"run_key"`
		Devices []string
	}
	ok(t, cs, "run_test_case", map[string]any{"key": "SHOP-T1", "options": map[string]any{"viewport": map[string]any{"width": 1440, "height": 900}}}, &legacy)
	if strings.Join(legacy.Devices, "|") != "Laptop · 1440×900" {
		t.Fatalf("viewport input: %+v", legacy)
	}
	ok(t, cs, "cancel_run", map[string]any{"run_key": legacy.RunKey}, nil)

	// Finish the 3-device run: desktop passed, iPhone failed on s2, custom passed.
	for i, st := range []string{"passed", "failed", "passed"} {
		c := run.Cases[i]
		rnExec(t, e, `UPDATE run_steps SET status = CASE WHEN status = 'skipped' THEN 'skipped' ELSE 'passed' END WHERE run_case_id = $1`, c.ID)
		if st == "failed" {
			rnExec(t, e, `UPDATE run_steps SET status = 'failed', error_message = 'Menu button not found' WHERE run_case_id = $1 AND step_id = 's2'`, c.ID)
		}
		rnExec(t, e, `UPDATE run_cases SET status = $2, started_at = now(), finished_at = now() WHERE id = $1`, c.ID, st)
	}
	rnExec(t, e, `UPDATE runs SET status = 'failed', started_at = now(), finished_at = now() WHERE id = $1`, run.ID)

	var done struct {
		Status   string
		Devices  []map[string]any
		Failures []struct {
			Case   string
			Device string
			StepID string `json:"step_id"`
		}
	}
	ok(t, cs, "wait_for_run", map[string]any{"run_key": started.RunKey, "timeout_s": 1}, &done)
	if done.Status != "failed" || len(done.Devices) != 3 || done.Devices[1]["status"] != "failed" || done.Devices[0]["status"] != "passed" ||
		done.Devices[1]["device"] != "iPhone 15 · 393×659" || len(done.Failures) != 1 || done.Failures[0].Device != "iPhone 15 · 393×659" || done.Failures[0].StepID != "s2" {
		t.Fatalf("wait_for_run: %+v", done)
	}

	var report struct {
		Devices       []string
		DeviceSummary []struct {
			Device string
			Status string
			Cases  int
			Passed int
			Failed int
		} `json:"device_summary"`
		Cases []struct {
			Device string
			Status string
			Steps  []struct {
				StepID string `json:"step_id"`
				Status string
				OnlyOn []string `json:"only_on"`
			}
		}
	}
	ok(t, cs, "get_run_report", map[string]any{"run_key": started.RunKey, "include_screenshots": "none"}, &report)
	if len(report.Devices) != 3 || len(report.DeviceSummary) != 3 || report.DeviceSummary[1].Failed != 1 || report.DeviceSummary[2].Passed != 1 || report.DeviceSummary[2].Status != "passed" {
		t.Fatalf("report devices: %+v", report)
	}
	if len(report.Cases) != 3 || report.Cases[0].Device != "Desktop · 1280×720" || report.Cases[2].Device != "390×844" || report.Cases[1].Status != "failed" {
		t.Fatalf("report cases: %+v", report.Cases)
	}
	s2 := report.Cases[0].Steps[1]
	if s2.StepID != "s2" || s2.Status != "skipped" || strings.Join(s2.OnlyOn, ",") != "mobile" || report.Cases[0].Steps[0].OnlyOn != nil {
		t.Fatalf("report step only_on: %+v", report.Cases[0].Steps)
	}
}

func (f *mcpFixture) runByKey(key string) runs.Run {
	f.e.t.Helper()
	var run runs.Run
	f.browser.expect("GET", "/api/v1/runs/"+key, nil, 200, &run)
	return run
}
