package runs

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/devices"
)

// Run statuses (runs.status).
const (
	StatusQueued         = "queued"
	StatusRunning        = "running"
	StatusAwaitingManual = "awaiting_manual"
	StatusPassed         = "passed"
	StatusFailed         = "failed"
	StatusBlocked        = "blocked"
	StatusError          = "error"
	StatusCancelled      = "cancelled"
)

// Case / step statuses (run_cases.status, run_steps.status).
const (
	StepPending = "pending"
	StepRunning = "running"
	StepPassed  = "passed"
	StepFailed  = "failed"
	StepBlocked = "blocked"
	StepSkipped = "skipped"
	StepError   = "error"
)

// Kinds, triggers and executions.
const (
	KindTestCase = "test_case"
	KindFlow     = "flow"

	TriggerManual   = "manual"
	TriggerAPI      = "api"
	TriggerMCP      = "mcp"
	TriggerSchedule = "schedule"

	ExecutionAutomated = "automated"
	ExecutionManual    = "manual"
)

// Run is the OpenAPI Run schema (RunSummary + detail).
type Run struct {
	RunSummary
	Options         json.RawMessage `json:"options"`
	SharedSession   bool            `json:"shared_session"`
	StopOnFailure   bool            `json:"stop_on_failure"`
	ErrorMessage    *string         `json:"error_message"`
	CancelRequested bool            `json:"cancel_requested"`
	ResumePosition  *int            `json:"resume_position"`
	Cases           []RunCase       `json:"cases"`
}

// RunCase is the OpenAPI RunCase schema.
type RunCase struct {
	ID               uuid.UUID            `json:"id"`
	Position         int                  `json:"position"`
	DeviceIndex      int                  `json:"device_index"` // index into Run.Devices() (options.devices)
	TestCaseID       uuid.UUID            `json:"test_case_id"`
	TestCaseKey      string               `json:"test_case_key"`
	TestCaseRevision int                  `json:"test_case_revision"`
	Title            string               `json:"title"`
	Execution        string               `json:"execution"`
	Status           string               `json:"status"`
	ExecutedBy       *auth.UserRef        `json:"executed_by"`
	StartedAt        *time.Time           `json:"started_at"`
	FinishedAt       *time.Time           `json:"finished_at"`
	DurationMS       *int64               `json:"duration_ms"`
	Video            *artifacts.Artifact  `json:"video"`
	Attachments      []artifacts.Artifact `json:"attachments"`
	Steps            []RunStep            `json:"steps"`

	continueOnFailure bool
}

// RunStep is the OpenAPI RunStep schema.
type RunStep struct {
	ID           uuid.UUID           `json:"id"`
	Position     int                 `json:"position"`
	StepID       string              `json:"step_id"`
	Action       string              `json:"action"`
	Summary      string              `json:"summary"`
	Description  string              `json:"description"`
	Expected     string              `json:"expected"`
	OnlyOn       []string            `json:"only_on"` // nil (null) = every device
	Status       string              `json:"status"`
	DurationMS   *int64              `json:"duration_ms"`
	ErrorMessage *string             `json:"error_message"`
	ActualResult *string             `json:"actual_result"`
	Screenshot   *artifacts.Artifact `json:"screenshot"`
	Details      json.RawMessage     `json:"details"`
}

// Devices returns the run's devices (options.devices; one device from the
// viewport for runs created before docs/14). Never empty.
func (r Run) Devices() []devices.Device { return devices.FromOptions(r.Options) }

// DeviceOf returns the device of a run case (falls back to the first device
// for an out-of-range index).
func (r Run) DeviceOf(c RunCase) devices.Device {
	devs := r.Devices()
	if c.DeviceIndex >= 0 && c.DeviceIndex < len(devs) {
		return devs[c.DeviceIndex]
	}
	return devs[0]
}

// IsFinal reports a terminal run status.
func IsFinal(status string) bool {
	switch status {
	case StatusPassed, StatusFailed, StatusBlocked, StatusError, StatusCancelled:
		return true
	}
	return false
}

// runRow is the subset of runs columns the service needs for decisions.
type runRow struct {
	ID              uuid.UUID
	Key             string
	ProjectID       uuid.UUID
	Kind            string
	TestCaseID      *uuid.UUID
	FlowID          *uuid.UUID
	EnvironmentID   *uuid.UUID
	Status          string
	TriggeredBy     uuid.UUID
	AssigneeID      *uuid.UUID
	StopOnFailure   bool
	ResumePosition  *int
	CancelRequested bool
	Options         json.RawMessage
	StartedAt       *time.Time
}

const runRowSelect = `
SELECT r.id, p.key || '-R' || r.seq, r.project_id, r.kind, r.test_case_id, r.flow_id, r.environment_id,
	r.status, r.triggered_by, r.assignee_id, r.stop_on_failure, r.resume_position, r.cancel_requested,
	r.options, r.started_at
FROM runs r JOIN projects p ON p.id = r.project_id`

func scanRunRow(row interface{ Scan(...any) error }) (runRow, error) {
	var r runRow
	err := row.Scan(&r.ID, &r.Key, &r.ProjectID, &r.Kind, &r.TestCaseID, &r.FlowID, &r.EnvironmentID,
		&r.Status, &r.TriggeredBy, &r.AssigneeID, &r.StopOnFailure, &r.ResumePosition, &r.CancelRequested,
		&r.Options, &r.StartedAt)
	return r, err
}

// loadRun builds the full Run DTO (no authorisation). Returns pgx.ErrNoRows
// (db.IsNoRows) when the run does not exist.
func loadRun(ctx context.Context, q db.Querier, runID uuid.UUID) (Run, error) {
	sums, err := QuerySummaries(ctx, q, "WHERE r.id = $1", runID)
	if err != nil {
		return Run{}, err
	}
	if len(sums) == 0 {
		return Run{}, errNoRun
	}
	run := Run{RunSummary: sums[0], Cases: []RunCase{}}
	err = q.QueryRow(ctx, `
		SELECT options, shared_session, stop_on_failure, error_message, cancel_requested, resume_position
		FROM runs WHERE id = $1`, runID).
		Scan(&run.Options, &run.SharedSession, &run.StopOnFailure, &run.ErrorMessage, &run.CancelRequested, &run.ResumePosition)
	if err != nil {
		return Run{}, err
	}
	run.Options, _ = NormalizeOptions(run.Options) // legacy runs: devices synthesized from the viewport

	// Artifacts of the run, indexed by id and grouped as attachments per case.
	arts := map[uuid.UUID]artifacts.Artifact{}
	attachments := map[uuid.UUID][]artifacts.Artifact{}
	rows, err := q.Query(ctx, `SELECT `+artifacts.Columns+` FROM artifacts a WHERE a.run_id = $1 ORDER BY a.created_at, a.id`, runID)
	if err != nil {
		return Run{}, err
	}
	for rows.Next() {
		a, err := artifacts.ScanRow(rows)
		if err != nil {
			rows.Close()
			return Run{}, err
		}
		arts[a.ID] = a.Artifact
		if a.Kind == artifacts.KindAttachment && a.RunCaseID != nil {
			attachments[*a.RunCaseID] = append(attachments[*a.RunCaseID], a.Artifact)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Run{}, err
	}
	artPtr := func(id *uuid.UUID) *artifacts.Artifact {
		if id == nil {
			return nil
		}
		if a, ok := arts[*id]; ok {
			return &a
		}
		return nil
	}

	rows, err = q.Query(ctx, `
		SELECT c.id, c.position, c.device_index, c.test_case_id, c.test_case_key, c.test_case_revision, c.title, c.execution,
			c.status, c.executed_by, u.name, u.email, c.started_at, c.finished_at, c.duration_ms,
			c.video_artifact_id, c.continue_on_failure
		FROM run_cases c LEFT JOIN users u ON u.id = c.executed_by
		WHERE c.run_id = $1 ORDER BY c.position`, runID)
	if err != nil {
		return Run{}, err
	}
	caseIdx := map[uuid.UUID]int{}
	for rows.Next() {
		var (
			c               RunCase
			exID            *uuid.UUID
			exName, exEmail *string
			started, fin    *time.Time
			videoID         *uuid.UUID
			duration        *int32
		)
		if err := rows.Scan(&c.ID, &c.Position, &c.DeviceIndex, &c.TestCaseID, &c.TestCaseKey, &c.TestCaseRevision, &c.Title, &c.Execution,
			&c.Status, &exID, &exName, &exEmail, &started, &fin, &duration, &videoID, &c.continueOnFailure); err != nil {
			rows.Close()
			return Run{}, err
		}
		if exID != nil {
			ref := auth.NewUserRef(exID, exName, exEmail)
			c.ExecutedBy = &ref
		}
		c.StartedAt, c.FinishedAt = auth.UTCPtr(started), auth.UTCPtr(fin)
		c.DurationMS = int64Ptr(duration)
		c.Video = artPtr(videoID)
		c.Attachments = attachments[c.ID]
		if c.Attachments == nil {
			c.Attachments = []artifacts.Artifact{}
		}
		c.Steps = []RunStep{}
		caseIdx[c.ID] = len(run.Cases)
		run.Cases = append(run.Cases, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Run{}, err
	}

	rows, err = q.Query(ctx, `
		SELECT s.run_case_id, s.id, s.position, s.step_id, s.action, s.summary, s.description, s.expected, s.only_on,
			s.status, s.duration_ms, s.error_message, s.actual_result, s.screenshot_artifact_id, s.details
		FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id
		WHERE c.run_id = $1 ORDER BY c.position, s.position`, runID)
	if err != nil {
		return Run{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			caseID   uuid.UUID
			s        RunStep
			duration *int32
			shotID   *uuid.UUID
			details  []byte
		)
		if err := rows.Scan(&caseID, &s.ID, &s.Position, &s.StepID, &s.Action, &s.Summary, &s.Description, &s.Expected, &s.OnlyOn,
			&s.Status, &duration, &s.ErrorMessage, &s.ActualResult, &shotID, &details); err != nil {
			return Run{}, err
		}
		s.DurationMS = int64Ptr(duration)
		s.Screenshot = artPtr(shotID)
		if len(details) > 0 {
			s.Details = json.RawMessage(details)
		} else {
			s.Details = json.RawMessage("null")
		}
		if i, ok := caseIdx[caseID]; ok {
			run.Cases[i].Steps = append(run.Cases[i].Steps, s)
		}
	}
	return run, rows.Err()
}

func int64Ptr(v *int32) *int64 {
	if v == nil {
		return nil
	}
	n := int64(*v)
	return &n
}
