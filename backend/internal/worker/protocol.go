package worker

import (
	"encoding/json"
	"errors"
	"fmt"
)

// NDJSON protocol between the worker and the Node runner (docs/13 "Runs, worker and
// runner protocol", runner/src/protocol.ts). One JSON object per line.

// Runner → worker event types.
const (
	evReady        = "ready"
	evCaseStarted  = "case.started"
	evStepStarted  = "step.started"
	evStepFinished = "step.finished"
	evCaseFinished = "case.finished"
	evRunFinished  = "run.finished"
	evRunnerError  = "runner.error"
)

// RunStart is the run.start message (worker → runner).
type RunStart struct {
	Type          string         `json:"type"` // "run.start"
	RunID         string         `json:"run_id"`
	ArtifactDir   string         `json:"artifact_dir"`
	Options       map[string]any `json:"options"`
	SharedSession bool           `json:"shared_session"`
	StopOnFailure bool           `json:"stop_on_failure"`
	Env           map[string]any `json:"env"`
	Secrets       map[string]any `json:"secrets"`
	Vars          map[string]any `json:"vars"`
	Cases         []WireCase     `json:"cases"`
}

// WireCase is one case of a run.start segment. CaseID is the run_cases id.
type WireCase struct {
	CaseID            string           `json:"case_id"`
	ContinueOnFailure bool             `json:"continue_on_failure"`
	Vars              map[string]any   `json:"vars"`
	Steps             []map[string]any `json:"steps"` // DSL params flat + step_id (= run_steps id)
}

type runCancel struct {
	Type  string `json:"type"` // "run.cancel"
	RunID string `json:"run_id"`
}

// Event is one decoded runner → worker line. Fields not used by a type stay zero.
type Event struct {
	Type       string          `json:"type"`
	Playwright string          `json:"playwright,omitempty"`
	RunID      *string         `json:"run_id"` // null on runner.error for unparseable input
	CaseID     string          `json:"case_id,omitempty"`
	StepID     string          `json:"step_id,omitempty"`
	Status     string          `json:"status,omitempty"`
	DurationMS *int64          `json:"duration_ms,omitempty"`
	Error      *string         `json:"error,omitempty"`
	Screenshot *string         `json:"screenshot,omitempty"`
	Video      *string         `json:"video,omitempty"`
	Details    json.RawMessage `json:"details,omitempty"`
	Message    string          `json:"message,omitempty"`
}

// Run returns the run id or "" (runner.error without a run).
func (e Event) Run() string {
	if e.RunID == nil {
		return ""
	}
	return *e.RunID
}

var (
	stepStatuses = map[string]bool{"passed": true, "failed": true, "error": true, "skipped": true}
	runStatuses  = map[string]bool{"passed": true, "failed": true, "error": true, "cancelled": true}
)

// DecodeEvent parses and validates one NDJSON line from the runner. Unknown event
// types are an error so the caller can log them; they never touch the database.
func DecodeEvent(line []byte) (Event, error) {
	var ev Event
	if err := json.Unmarshal(line, &ev); err != nil {
		return Event{}, fmt.Errorf("invalid runner line: %w", err)
	}
	needRun := func() error {
		if ev.Run() == "" {
			return fmt.Errorf("%s without run_id", ev.Type)
		}
		return nil
	}
	switch ev.Type {
	case evReady:
		return ev, nil
	case evCaseStarted:
		if err := needRun(); err != nil {
			return Event{}, err
		}
		if ev.CaseID == "" {
			return Event{}, errors.New("case.started without case_id")
		}
	case evStepStarted:
		if err := needRun(); err != nil {
			return Event{}, err
		}
		if ev.CaseID == "" || ev.StepID == "" {
			return Event{}, errors.New("step.started without case_id/step_id")
		}
	case evStepFinished:
		if err := needRun(); err != nil {
			return Event{}, err
		}
		if ev.CaseID == "" || ev.StepID == "" {
			return Event{}, errors.New("step.finished without case_id/step_id")
		}
		if !stepStatuses[ev.Status] {
			return Event{}, fmt.Errorf("step.finished with invalid status %q", ev.Status)
		}
		if string(ev.Details) == "null" {
			ev.Details = nil
		}
	case evCaseFinished:
		if err := needRun(); err != nil {
			return Event{}, err
		}
		if ev.CaseID == "" {
			return Event{}, errors.New("case.finished without case_id")
		}
		if !stepStatuses[ev.Status] {
			return Event{}, fmt.Errorf("case.finished with invalid status %q", ev.Status)
		}
	case evRunFinished:
		if err := needRun(); err != nil {
			return Event{}, err
		}
		if !runStatuses[ev.Status] {
			return Event{}, fmt.Errorf("run.finished with invalid status %q", ev.Status)
		}
	case evRunnerError:
		return ev, nil
	default:
		return Event{}, fmt.Errorf("unknown runner event type %q", ev.Type)
	}
	return ev, nil
}

// caseTracker makes case events idempotent per segment: the runner may send case.finished
// twice for the first case of a shared-session segment (the second carries the video), and
// retries repeat case.started. It reports whether a case.finished is the first one.
type caseTracker struct {
	finished map[string]string // case_id → status of the first case.finished
}

func newCaseTracker() *caseTracker { return &caseTracker{finished: map[string]string{}} }

// finish records a case.finished and returns true when it is the first for this case.
func (t *caseTracker) finish(caseID, status string) bool {
	if _, ok := t.finished[caseID]; ok {
		return false
	}
	t.finished[caseID] = status
	return true
}

func (t *caseTracker) isFinished(caseID string) bool {
	_, ok := t.finished[caseID]
	return ok
}
