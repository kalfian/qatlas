package projects

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/kalfian/qatlas/backend/internal/devices"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

func TestMergeRunOptions(t *testing.T) {
	o, err := MergeRunOptions(nil, json.RawMessage(`null`))
	if err != nil || !o.Equal(DefaultRunOptions()) {
		t.Fatalf("defaults: %+v %v", o, err)
	}
	o, err = MergeRunOptions(
		json.RawMessage(`{"browser":"firefox","viewport":{"width":1920,"height":1080},"unknown":1}`),
		json.RawMessage(`{"viewport":{"width":1440},"retries":null,"video":"always"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultRunOptions()
	want.Browser, want.Video, want.Viewport = "firefox", "always", Viewport{Width: 1440, Height: 1080}
	want.Devices = []devices.Device{devices.Custom(1440, 1080, "", "")}
	if !o.Equal(want) {
		t.Fatalf("merged: %+v", o)
	}
	if errs := o.Validate("x."); len(errs) != 0 {
		t.Fatalf("valid options rejected: %v", errs)
	}
	bad := RunOptions{Browser: "ie", Screenshot: "x", Video: "x", Retries: 3, StepTimeoutMS: 1}
	if errs := bad.Validate("default_run_options."); len(errs) != 7 || errs[0].Path != "default_run_options.browser" {
		t.Fatalf("invalid options: %v", errs)
	}
	if _, err := MergeRunOptions(json.RawMessage(`"nope"`)); err == nil {
		t.Fatal("non-object must fail")
	}
}

func TestMergeRunOptionsDevices(t *testing.T) {
	iphone, _ := devices.Preset("iphone-15")
	// Stored resolved devices win; viewport = devices[0].
	o, err := MergeRunOptions(json.RawMessage(`{"viewport":{"width":1280,"height":720},"devices":[{"id":"iphone-15","label":"iPhone 15","category":"mobile","width":393,"height":659,"device_scale_factor":3,"is_mobile":true,"has_touch":true},{"id":"desktop","label":"Desktop","category":"desktop","width":1280,"height":720,"device_scale_factor":1,"is_mobile":false,"has_touch":false}]}`))
	if err != nil || len(o.Devices) != 2 || o.Devices[0].ID != "iphone-15" || o.Viewport != (Viewport{393, 659}) {
		t.Fatalf("stored devices: %+v %v", o, err)
	}
	// Legacy options (no devices): one device from the viewport.
	o, _ = MergeRunOptions(json.RawMessage(`{"viewport":{"width":1920,"height":1080}}`))
	if len(o.Devices) != 1 || o.Devices[0].ID != "desktop-fhd" {
		t.Fatalf("legacy: %+v", o.Devices)
	}
	// A later viewport-only layer replaces earlier devices.
	o, _ = MergeRunOptions(json.RawMessage(`{"devices":[{"id":"iphone-15","label":"iPhone 15","category":"mobile","width":393,"height":659,"device_scale_factor":3,"is_mobile":true,"has_touch":true}]}`),
		json.RawMessage(`{"viewport":{"width":1440,"height":900}}`))
	if len(o.Devices) != 1 || o.Devices[0].ID != "laptop" || o.Viewport != (Viewport{1440, 900}) {
		t.Fatalf("viewport layer: %+v", o)
	}

	cur := DefaultRunOptions()
	got, err := ApplyRunOptionsInput(cur, json.RawMessage(`{"devices":[{"id":"iphone-15"},{"id":"custom","width":800,"height":1280,"label":"Kiosk"}],"viewport":{"width":1920,"height":1080},"video":"always"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Devices, []devices.Device{iphone, devices.Custom(800, 1280, "", "Kiosk")}) || got.Viewport != (Viewport{393, 659}) || got.Video != "always" {
		t.Fatalf("devices input: %+v", got)
	}
	if !cur.Equal(DefaultRunOptions()) {
		t.Fatal("ApplyRunOptionsInput must not modify cur")
	}
	got, _ = ApplyRunOptionsInput(got, json.RawMessage(`{"retries":1}`))
	if len(got.Devices) != 2 || got.Retries != 1 {
		t.Fatalf("other keys keep devices: %+v", got)
	}
	got, _ = ApplyRunOptionsInput(got, json.RawMessage(`{"viewport":{"width":1440,"height":900}}`))
	if len(got.Devices) != 1 || got.Devices[0].ID != "laptop" {
		t.Fatalf("lone viewport: %+v", got.Devices)
	}
	for _, c := range []struct {
		raw   string
		paths []string
	}{
		{`{"devices":[]}`, []string{"default_run_options.devices"}},
		{`{"devices":[{"id":"nope"}],"browser":"ie"}`, []string{"default_run_options.browser", "default_run_options.devices[0].id"}},
		{`{"devices":[{"id":"custom","width":100,"height":800}]}`, []string{"default_run_options.devices[0].width"}},
		{`{"devices":[{"id":"desktop"},{"id":"desktop"}]}`, []string{"default_run_options.devices[1]"}},
		{`{"viewport":{"width":100,"height":800}}`, []string{"default_run_options.viewport.width"}},
		{`{"viewport":{"width":"wide"}}`, []string{"default_run_options.viewport.width"}},
	} {
		_, err := ApplyRunOptionsInput(cur, json.RawMessage(c.raw))
		ae, ok := err.(*httpx.APIError)
		if !ok || ae.Status != 400 {
			t.Fatalf("%s: %v", c.raw, err)
		}
		var paths []string
		for _, d := range ae.Details {
			paths = append(paths, d.Path)
		}
		if !reflect.DeepEqual(paths, c.paths) {
			t.Errorf("%s: %v, want %v", c.raw, paths, c.paths)
		}
	}
}

func TestComputeStatsTimezoneBuckets(t *testing.T) {
	jkt, err := time.LoadLocation("Asia/Jakarta") // UTC+7, no DST
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 3, 10, 20, 0, 0, 0, time.UTC) // 2026-03-11 03:00 in Jakarta
	runAt := func(h int, status string) statsRun {
		q := now.Add(-time.Duration(h) * time.Hour)
		return statsRun{Status: status, Queued: q}
	}
	// 4 h ago = 2026-03-10 16:00 UTC = 23:00 Jakarta (yesterday there, today in UTC).
	runs := []statsRun{runAt(1, "passed"), runAt(4, "failed"), runAt(5, "running")}

	utc := computeStats("7d", now, time.UTC, runs, nil, 0)
	if utc.Daily[6].Date != "2026-03-10" || utc.Daily[6].Passed != 1 || utc.Daily[6].Failed != 1 || utc.Daily[6].Other != 1 {
		t.Fatalf("utc buckets: %+v", utc.Daily)
	}
	local := computeStats("7d", now, jkt, runs, nil, 0)
	if local.Daily[6].Date != "2026-03-11" || local.Daily[6].Passed != 1 || local.Daily[5].Failed != 1 || local.Daily[5].Other != 1 {
		t.Fatalf("jakarta buckets: %+v", local.Daily)
	}
	if local.PassRate == nil || *local.PassRate != 0.5 || local.AvgDurationMS != nil || len(local.TopFailing) != 0 {
		t.Fatalf("aggregates: %+v", local)
	}
}

func TestComputeStatsTopFailingOrder(t *testing.T) {
	var cases []statsCase
	add := func(key, status string, n int) {
		for range n {
			cases = append(cases, statsCase{Key: key, Title: "t " + key, Status: status})
		}
	}
	// Ties keep first-seen order (stable sort, like the mock).
	add("A", "failed", 1)
	add("B", "error", 3)
	add("C", "failed", 1)
	add("D", "passed", 4)
	add("E", "failed", 2)
	add("F", "failed", 1)
	add("G", "failed", 1)
	st := computeStats("7d", time.Now(), time.UTC, nil, cases, 0)
	got := ""
	for _, f := range st.TopFailing {
		got += f.TestCaseKey
	}
	if got != "BEACF" || st.PassRate != nil || st.TotalRuns != 0 {
		t.Fatalf("top failing order %q: %+v", got, st)
	}
}
