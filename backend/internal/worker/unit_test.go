package worker

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/dsl"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

func cs(pos int, exec, status string, cof bool) CaseState {
	return CaseState{ID: string(rune('a' + pos)), Position: pos, Execution: exec, Status: status, ContinueOnFailure: cof}
}

func TestNextPlan(t *testing.T) {
	const A, M = "automated", "manual"
	tests := []struct {
		name  string
		cases []CaseState
		stop  bool
		kind  PlanKind
		seg   []int // positions
		pos   int
		skip  []int
	}{
		{name: "empty run finalizes", kind: PlanFinalize},
		{name: "single automated", cases: []CaseState{cs(1, A, "pending", false)}, stop: true, kind: PlanSegment, seg: []int{1}},
		{name: "segment stops before manual",
			cases: []CaseState{cs(1, A, "pending", false), cs(2, A, "pending", false), cs(3, M, "pending", false), cs(4, A, "pending", false)},
			stop:  true, kind: PlanSegment, seg: []int{1, 2}},
		{name: "unsorted input",
			cases: []CaseState{cs(3, M, "pending", false), cs(2, A, "pending", false), cs(1, A, "pending", false)},
			kind:  PlanSegment, seg: []int{1, 2}},
		{name: "first manual parks",
			cases: []CaseState{cs(1, M, "pending", false), cs(2, A, "pending", false)},
			kind:  PlanAwaitManual, pos: 1},
		{name: "resume after manual case",
			cases: []CaseState{cs(1, A, "passed", false), cs(2, M, "passed", false), cs(3, A, "pending", false), cs(4, A, "pending", false)},
			stop:  true, kind: PlanSegment, seg: []int{3, 4}},
		{name: "after segment the manual case is next",
			cases: []CaseState{cs(1, A, "passed", false), cs(2, M, "pending", false), cs(3, A, "pending", false)},
			stop:  true, kind: PlanAwaitManual, pos: 2},
		{name: "stop_on_failure skips the rest (manual included)",
			cases: []CaseState{cs(1, A, "failed", false), cs(2, M, "pending", false), cs(3, A, "pending", false)},
			stop:  true, kind: PlanSkipRest, skip: []int{2, 3}},
		{name: "blocked manual case stops too",
			cases: []CaseState{cs(1, M, "blocked", false), cs(2, A, "pending", false)},
			stop:  true, kind: PlanSkipRest, skip: []int{2}},
		{name: "continue_on_failure case does not stop",
			cases: []CaseState{cs(1, A, "error", true), cs(2, A, "pending", false)},
			stop:  true, kind: PlanSegment, seg: []int{2}},
		{name: "stop_on_failure off keeps going",
			cases: []CaseState{cs(1, A, "failed", false), cs(2, A, "pending", false)},
			stop:  false, kind: PlanSegment, seg: []int{2}},
		{name: "stale running case is executed again",
			cases: []CaseState{cs(1, A, "running", false), cs(2, A, "pending", false)},
			stop:  true, kind: PlanSegment, seg: []int{1, 2}},
		{name: "all done finalizes",
			cases: []CaseState{cs(1, A, "passed", false), cs(2, M, "failed", false), cs(3, A, "skipped", false)},
			stop:  true, kind: PlanFinalize},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NextPlan(tt.cases, tt.stop)
			if p.Kind != tt.kind {
				t.Fatalf("kind = %v, want %v (%+v)", p.Kind, tt.kind, p)
			}
			if got := positions(p.Segment); !equalInts(got, tt.seg) {
				t.Errorf("segment = %v, want %v", got, tt.seg)
			}
			if got := positions(p.Skip); !equalInts(got, tt.skip) {
				t.Errorf("skip = %v, want %v", got, tt.skip)
			}
			if p.Position != tt.pos {
				t.Errorf("position = %d, want %d", p.Position, tt.pos)
			}
		})
	}
}

func positions(cs []CaseState) []int {
	var out []int
	for _, c := range cs {
		out = append(out, c.Position)
	}
	return out
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestFinalRunStatus(t *testing.T) {
	tests := []struct {
		in   []string
		want string
	}{
		{nil, "passed"},
		{[]string{"passed", "skipped"}, "passed"},
		{[]string{"skipped"}, "passed"},
		{[]string{"passed", "blocked"}, "blocked"},
		{[]string{"blocked", "failed", "passed"}, "failed"},
		{[]string{"failed", "error", "blocked"}, "error"},
	}
	for _, tt := range tests {
		if got := FinalRunStatus(tt.in); got != tt.want {
			t.Errorf("FinalRunStatus(%v) = %s, want %s", tt.in, got, tt.want)
		}
		// Must agree with the shared state machine used by complete-manual.
		if got := runs.RunStatusFromCases(tt.in); got != tt.want {
			t.Errorf("runs.RunStatusFromCases(%v) = %s, want %s", tt.in, got, tt.want)
		}
	}
}

func TestMasker(t *testing.T) {
	m := NewMasker([]string{"s3cret-pw", "s3cret", "ab", "", "s3cret"})
	if got := m.String("login with s3cret-pw then s3cret"); got != "login with •••• then ••••" {
		t.Fatalf("String: %q", got)
	}
	if got := m.String("ab stays (too short)"); got != "ab stays (too short)" {
		t.Fatalf("short value masked: %q", got)
	}
	if got := m.Ptr(nil); got != nil {
		t.Fatal("Ptr(nil) must stay nil")
	}
	raw := json.RawMessage(`{"expected":"s3cret","actual":"x","response":{"body":{"token":"s3cret-pw","list":["a","s3cret"]},"status":200},"s3cret":1}`)
	got := string(m.JSON(raw))
	if strings.Contains(got, "s3cret") {
		t.Fatalf("JSON not masked: %s", got)
	}
	var back map[string]any
	if err := json.Unmarshal([]byte(got), &back); err != nil {
		t.Fatalf("masked JSON invalid: %v", err)
	}
	if back["expected"] != MaskText || back["response"].(map[string]any)["status"].(float64) != 200 {
		t.Fatalf("unexpected masked JSON: %s", got)
	}
	if got := string(m.JSON(json.RawMessage(`not json s3cret`))); got != "not json ••••" {
		t.Fatalf("invalid JSON fallback: %q", got)
	}
	var empty *Masker
	if empty.String("x") != "x" || string(NewMasker(nil).JSON(raw)) != string(raw) {
		t.Fatal("empty masker must be a no-op")
	}
}

func TestDecodeEvent(t *testing.T) {
	good := []string{
		`{"type":"ready","playwright":"1.64.1"}`,
		`{"type":"case.started","run_id":"r","case_id":"c"}`,
		`{"type":"step.started","run_id":"r","case_id":"c","step_id":"s"}`,
		`{"type":"step.finished","run_id":"r","case_id":"c","step_id":"s","status":"failed","duration_ms":12,"error":"boom","screenshot":"/tmp/x.png","details":{"expected":"a","actual":"b"}}`,
		`{"type":"step.finished","run_id":"r","case_id":"c","step_id":"s","status":"skipped","duration_ms":0,"error":null,"screenshot":null,"details":null}`,
		`{"type":"case.finished","run_id":"r","case_id":"c","status":"passed","video":null}`,
		`{"type":"run.finished","run_id":"r","status":"cancelled"}`,
		`{"type":"runner.error","run_id":null,"message":"bad line"}`,
	}
	for _, line := range good {
		if _, err := DecodeEvent([]byte(line)); err != nil {
			t.Errorf("DecodeEvent(%s): %v", line, err)
		}
	}
	ev, _ := DecodeEvent([]byte(good[3]))
	if ev.Run() != "r" || *ev.DurationMS != 12 || *ev.Error != "boom" || *ev.Screenshot != "/tmp/x.png" || !strings.Contains(string(ev.Details), "expected") {
		t.Fatalf("decoded: %+v", ev)
	}
	ev, _ = DecodeEvent([]byte(good[4]))
	if ev.Details != nil || ev.Error != nil || ev.Screenshot != nil {
		t.Fatalf("nulls must decode to nil: %+v", ev)
	}
	ev, _ = DecodeEvent([]byte(good[7]))
	if ev.Run() != "" || ev.Message != "bad line" {
		t.Fatalf("runner.error: %+v", ev)
	}

	bad := []string{
		`not json`,
		`{"type":"mystery","run_id":"r"}`,
		`{"type":"case.started","case_id":"c"}`,
		`{"type":"step.finished","run_id":"r","case_id":"c","step_id":"s","status":"weird"}`,
		`{"type":"case.finished","run_id":"r","case_id":"c","status":"cancelled"}`,
		`{"type":"run.finished","run_id":"r","status":"skipped"}`,
		`{"type":"step.started","run_id":"r","case_id":"c"}`,
	}
	for _, line := range bad {
		if _, err := DecodeEvent([]byte(line)); err == nil {
			t.Errorf("DecodeEvent(%s): expected error", line)
		}
	}
}

func TestCaseTrackerDuplicateFinished(t *testing.T) {
	// Shared-session segment: the first case.finished arrives with video:null, then again
	// (same status) with the video right before run.finished.
	lines := []string{
		`{"type":"case.started","run_id":"r","case_id":"c1"}`,
		`{"type":"case.finished","run_id":"r","case_id":"c1","status":"passed","video":null}`,
		`{"type":"case.started","run_id":"r","case_id":"c2"}`,
		`{"type":"case.finished","run_id":"r","case_id":"c2","status":"failed","video":null}`,
		`{"type":"case.finished","run_id":"r","case_id":"c1","status":"passed","video":"/d/c1/video.webm"}`,
		`{"type":"run.finished","run_id":"r","status":"failed"}`,
	}
	tr := newCaseTracker()
	var firsts, repeats []string
	for _, l := range lines {
		ev, err := DecodeEvent([]byte(l))
		if err != nil {
			t.Fatal(err)
		}
		if ev.Type != evCaseFinished {
			continue
		}
		if tr.finish(ev.CaseID, ev.Status) {
			firsts = append(firsts, ev.CaseID)
		} else {
			repeats = append(repeats, ev.CaseID)
			if ev.Video == nil || *ev.Video != "/d/c1/video.webm" {
				t.Fatalf("repeat must carry the video: %+v", ev)
			}
		}
	}
	if strings.Join(firsts, ",") != "c1,c2" || strings.Join(repeats, ",") != "c1" {
		t.Fatalf("firsts=%v repeats=%v", firsts, repeats)
	}
	if !tr.isFinished("c1") || tr.isFinished("c3") {
		t.Fatal("isFinished")
	}
}

func TestParseSnapshotAndWireSteps(t *testing.T) {
	rc1, rc2 := uuid.New(), uuid.New()
	tc1, tc2 := uuid.New(), uuid.New()
	snap := runs.Snapshot{
		Kind: runs.KindFlow,
		Flow: &runs.FlowSnapshot{Variables: json.RawMessage(`{"email":"a@b.c"}`)},
		Environment: &runs.EnvSnapshot{Name: "staging", Variables: map[string]string{"BASE_URL": "http://x"},
			SecretNames: []string{"QA_PASSWORD"}},
		Cases: []runs.CaseSnapshot{
			{RunCaseID: rc1, Position: 1, TestCaseID: tc1, TestCaseKey: "SHOP-T1", Variables: json.RawMessage(`{"q":"kaos"}`),
				Steps: []dsl.Step{{"id": "st_a", "action": "goto", "url": "{{env.BASE_URL}}/"}, {"id": "st_b", "action": "click", "selector": "#b", "screenshot": true, "timeout_ms": 500.0}}},
			{RunCaseID: rc2, Position: 2, TestCaseID: tc2, TestCaseKey: "SHOP-T2", Variables: nil, Execution: "manual"},
		},
	}
	raw, _ := json.Marshal(snap)
	s, err := parseSnapshot(raw)
	if err != nil {
		t.Fatal(err)
	}
	if s.Env["BASE_URL"] != "http://x" || s.Vars["email"] != "a@b.c" || len(s.SecretNames) != 1 || len(s.Cases) != 2 {
		t.Fatalf("snapshot: %+v", s)
	}
	c, ok := s.caseFor(rc1.String(), 1, tc1.String())
	if !ok || c.Vars["q"] != "kaos" {
		t.Fatalf("caseFor: %+v %v", c, ok)
	}
	if c2, ok := s.caseFor(uuid.NewString(), 2, tc2.String()); !ok || c2.RunCaseID != rc2.String() || c2.Vars == nil {
		t.Fatalf("caseFor by position: %+v", c2)
	}
	if _, ok := c.stepFor("st_x", 1); ok {
		t.Fatal("stepFor must check the DSL id")
	}
	st, ok := c.stepFor("st_b", 2)
	if !ok {
		t.Fatal("stepFor")
	}
	w := wireStep(st, "rs-2", "click", false, true)
	if w["step_id"] != "rs-2" || w["id"] != nil || w["enabled"] != false || w["continue_on_failure"] != true ||
		w["screenshot"] != true || w["timeout_ms"] != 500.0 || w["selector"] != "#b" {
		t.Fatalf("wire step: %v", w)
	}
	st, _ = c.stepFor("st_a", 1)
	w = wireStep(st, "rs-1", "goto", true, false)
	if v, ok := w["timeout_ms"]; !ok || v != nil || w["screenshot"] != false {
		t.Fatalf("wire step defaults: %v", w)
	}
	if st["id"] != "st_a" {
		t.Fatal("wireStep must not modify the snapshot step")
	}
	if _, err := parseSnapshot([]byte(`[]`)); err == nil {
		t.Fatal("non-object snapshot must fail")
	}
}

func TestRunnerOptions(t *testing.T) {
	got := runnerOptions(map[string]any{"browser": "webkit", "retries": 1.0, "run_timeout_ms": 5.0, "video": nil})
	if len(got) != 2 || got["browser"] != "webkit" || got["retries"] != 1.0 {
		t.Fatalf("runnerOptions: %v", got)
	}
}

func TestResolveRunnerCommand(t *testing.T) {
	if got := ResolveRunnerCommand("node /abs/main.js"); got != "node /abs/main.js" {
		t.Fatal(got)
	}
	if got := ResolveRunnerCommand("/usr/bin/qatlas-runner --flag"); got != "/usr/bin/qatlas-runner --flag" {
		t.Fatal(got)
	}
	// The test cwd is backend/internal/worker; runner/ lives at the repository root.
	got := ResolveRunnerCommand("node runner/eslint.config.js --x")
	argv := strings.Fields(got)
	if len(argv) != 3 || !filepath.IsAbs(argv[1]) || !strings.HasSuffix(argv[1], "/runner/eslint.config.js") || argv[2] != "--x" {
		t.Fatalf("relative script not resolved from a parent dir: %s", got)
	}
	if got := ResolveRunnerCommand("node runner/nope.js"); got != "node runner/nope.js" {
		t.Fatalf("missing file must stay unchanged: %s", got)
	}
}
