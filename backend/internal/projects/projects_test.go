package projects

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMergeRunOptions(t *testing.T) {
	o, err := MergeRunOptions(nil, json.RawMessage(`null`))
	if err != nil || o != DefaultRunOptions() {
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
	if o != want {
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
