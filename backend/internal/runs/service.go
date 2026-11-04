package runs

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/jobs"
)

// MaxAttachmentBytes is the tester attachment limit (mock: 25 MB → 413).
const MaxAttachmentBytes = 25 << 20

var errNoRun = pgx.ErrNoRows

// Service implements run creation, run state changes and run reads. REST
// handlers (handlers.go) and MCP tools call these methods.
type Service struct {
	pool   *pgxpool.Pool
	enq    jobs.Enqueuer
	store  artifacts.Store
	hub    *events.Hub
	logger *slog.Logger
}

// New builds the service. enq inserts run_execute jobs in the caller's
// transaction; store keeps attachments; hub may be nil (no SSE / WaitForChange).
func New(pool *pgxpool.Pool, enq jobs.Enqueuer, store artifacts.Store, hub *events.Hub, logger *slog.Logger) *Service {
	if enq == nil {
		enq = jobs.NoopEnqueuer{}
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{pool: pool, enq: enq, store: store, hub: hub, logger: logger}
}

// Hub returns the events hub (may be nil).
func (s *Service) Hub() *events.Hub { return s.hub }

/* ------------------------------------------------------------------ resolution */

// resolveRun authorises action on the run's project (404/403 like the mock's
// findRun: project first, then the run) and loads the run row, optionally
// locking it FOR UPDATE.
func resolveRun(ctx context.Context, q db.Querier, actor *auth.Actor, runKey string, action authz.Action, lock bool) (runRow, authz.Project, authz.Role, error) {
	key := strings.ToUpper(strings.TrimSpace(runKey))
	notFound := httpx.NotFound("Run " + key + " not found")
	pk, seq, ok := authz.ParseEntityKey(key, 'R')
	if !ok {
		if _, _, err := authz.ProjectAccess(ctx, q, actor, authz.ProjectKeyOf(key), action); err != nil {
			return runRow{}, authz.Project{}, "", err
		}
		return runRow{}, authz.Project{}, "", notFound
	}
	p, role, err := authz.ProjectAccess(ctx, q, actor, pk, action)
	if err != nil {
		return runRow{}, authz.Project{}, "", err
	}
	sql := runRowSelect + " WHERE r.project_id = $1 AND r.seq = $2"
	if lock {
		sql += " FOR UPDATE OF r"
	}
	r, err := scanRunRow(q.QueryRow(ctx, sql, p.ID, seq))
	if db.IsNoRows(err) {
		return runRow{}, authz.Project{}, "", notFound
	}
	if err != nil {
		return runRow{}, authz.Project{}, "", err
	}
	return r, p, role, nil
}

/* ------------------------------------------------------------------ reads */

// Get returns the full run (view permission).
func (s *Service) Get(ctx context.Context, actor *auth.Actor, runKey string) (Run, error) {
	r, _, _, err := resolveRun(ctx, s.pool, actor, runKey, authz.View, false)
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, r.ID)
}

// ListFilter are the GET /projects/{key}/runs query parameters.
type ListFilter struct {
	Status  string
	Target  string // partial match on target key / title / run key, exact on a case key
	Kind    string
	Trigger string
	From    string // YYYY-MM-DD (UTC date of queued_at), inclusive
	To      string // YYYY-MM-DD, inclusive
	Page    httpx.PageRequest
}

// List returns run summaries of a project, newest first.
func (s *Service) List(ctx context.Context, actor *auth.Actor, projectKey string, f ListFilter) (httpx.Page[RunSummary], error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View)
	if err != nil {
		return httpx.Page[RunSummary]{}, err
	}
	var fromDate, toDate *time.Time
	for _, d := range []struct {
		name, val string
		dst       **time.Time
	}{{"from", f.From, &fromDate}, {"to", f.To, &toDate}} {
		if d.val == "" {
			continue
		}
		t, err := time.Parse(time.DateOnly, d.val)
		if err != nil {
			return httpx.Page[RunSummary]{}, httpx.BadRequest("Invalid date", httpx.Field(d.name, "Use YYYY-MM-DD"))
		}
		*d.dst = &t
	}
	if f.Page.Limit == 0 {
		f.Page.Limit = httpx.DefaultLimit
	}
	limit, offset := f.Page.SQL()
	target := strings.ToUpper(strings.TrimSpace(f.Target))
	list, err := QuerySummaries(ctx, s.pool, `
		WHERE r.project_id = $1
		  AND ($2 = '' OR r.status = $2)
		  AND ($3 = '' OR strpos(upper(r.target_key), $3) > 0 OR strpos(upper(r.target_title), $3) > 0
		       OR strpos(p.key || '-R' || r.seq, $3) > 0
		       OR EXISTS (SELECT 1 FROM run_cases x WHERE x.run_id = r.id AND x.test_case_key = $3))
		  AND ($4 = '' OR r.kind = $4)
		  AND ($5 = '' OR r.trigger = $5)
		  AND ($6::date IS NULL OR (r.queued_at AT TIME ZONE 'UTC')::date >= $6::date)
		  AND ($7::date IS NULL OR (r.queued_at AT TIME ZONE 'UTC')::date <= $7::date)
		ORDER BY r.queued_at DESC, r.seq DESC
		LIMIT $8 OFFSET $9`,
		p.ID, f.Status, target, f.Kind, f.Trigger, fromDate, toDate, limit, offset)
	if err != nil {
		return httpx.Page[RunSummary]{}, err
	}
	return httpx.NewPage(list, f.Page), nil
}

// WaitForChange blocks until an event for the run arrives, timeout elapses or
// ctx ends, then returns the current run. changed reports whether an event
// arrived. Final runs return immediately (changed=false). Needs the hub.
func (s *Service) WaitForChange(ctx context.Context, actor *auth.Actor, runKey string, timeout time.Duration) (run Run, changed bool, err error) {
	run, err = s.Get(ctx, actor, runKey)
	if err != nil || IsFinal(run.Status) || s.hub == nil {
		return run, false, err
	}
	sub, err := s.hub.Subscribe(ctx, run.Key)
	if err != nil {
		return run, false, err
	}
	defer sub.Close()
	// Re-read after subscribing so a change between the first read and the
	// subscription is not missed.
	cur, err := s.Get(ctx, actor, runKey)
	if err != nil {
		return run, false, err
	}
	if cur.Status != run.Status || IsFinal(cur.Status) {
		return cur, true, nil
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-sub.C:
		changed = true
	case <-t.C:
	case <-ctx.Done():
		return cur, false, ctx.Err()
	}
	run, err = s.Get(ctx, actor, runKey)
	return run, changed, err
}

/* ------------------------------------------------------------------ create / rerun */

// CreateInput is the OpenAPI RunCreate body. Trigger is service-only: "" picks
// manual (session) or api (token); MCP passes TriggerMCP.
type CreateInput struct {
	TestCase      string          `json:"test_case"`
	Flow          string          `json:"flow"`
	EnvironmentID *string         `json:"environment_id"`
	Options       json.RawMessage `json:"options"`
	AssigneeID    *string         `json:"assignee_id"`
	Trigger       string          `json:"-"`
}

// Create snapshots the target and creates a run (202 in REST). Automated
// first case → queued + job enqueued in the same transaction; manual first
// case → awaiting_manual (no job).
func (s *Service) Create(ctx context.Context, actor *auth.Actor, projectKey string, in CreateInput) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, projectKey, authz.Run)
		if err != nil {
			return err
		}
		trigger, err := triggerFor(actor, in.Trigger)
		if err != nil {
			return err
		}
		sp := runSpec{project: p, trigger: trigger}
		switch {
		case strings.TrimSpace(in.TestCase) != "":
			key := strings.ToUpper(strings.TrimSpace(in.TestCase))
			sp.kind = KindTestCase
			pk, seq, ok := authz.ParseEntityKey(key, 'T')
			if ok && pk == p.Key {
				sp.testCase, err = loadTestCase(ctx, tx, "WHERE tc.project_id = $1 AND tc.seq = $2 AND tc.deleted_at IS NULL", p.ID, seq)
				if err != nil {
					return err
				}
			}
			if sp.testCase == nil {
				return httpx.Unprocessable("Test case " + key + " not found")
			}
			if err := validateTestCase(sp.testCase); err != nil {
				return err
			}
		case strings.TrimSpace(in.Flow) != "":
			key := strings.ToUpper(strings.TrimSpace(in.Flow))
			sp.kind = KindFlow
			pk, seq, ok := authz.ParseEntityKey(key, 'F')
			if ok && pk == p.Key {
				sp.flow, err = loadFlow(ctx, tx, "WHERE f.project_id = $1 AND f.seq = $2 AND f.deleted_at IS NULL", p.ID, seq)
				if err != nil {
					return err
				}
			}
			if sp.flow == nil {
				return httpx.Unprocessable("Flow " + key + " not found")
			}
			if err := validateFlow(sp.flow); err != nil {
				return err
			}
		default:
			return httpx.Unprocessable("Choose a test case or a flow")
		}

		if in.EnvironmentID != nil && strings.TrimSpace(*in.EnvironmentID) != "" {
			envID, perr := uuid.Parse(strings.TrimSpace(*in.EnvironmentID))
			if perr == nil {
				sp.env, err = loadEnv(ctx, tx, "WHERE e.id = $1 AND e.project_id = $2", envID, p.ID)
				if err != nil {
					return err
				}
			}
			if sp.env == nil {
				return httpx.Unprocessable("Environment not found", httpx.Field("environment_id", "Environment not found in this project"))
			}
		} else {
			sp.env, err = loadEnv(ctx, tx, "WHERE e.project_id = $1 AND e.is_default", p.ID)
			if err != nil {
				return err
			}
		}

		sp.options, err = mergeOptions(p.DefaultRunOptions, in.Options)
		if err != nil {
			return err
		}
		if in.AssigneeID != nil && strings.TrimSpace(*in.AssigneeID) != "" {
			id, err := checkAssignee(ctx, tx, p.ID, *in.AssigneeID)
			if err != nil {
				return err
			}
			sp.assigneeID = &id
		}
		runID, err = s.insertRun(ctx, tx, actor, sp)
		return err
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}

// RerunInput is the POST /runs/{key}/rerun body.
type RerunInput struct {
	OnlyFailed bool   `json:"only_failed"`
	Trigger    string `json:"-"`
}

// Rerun creates a new run of the same target with the same options and
// environment (current test case / flow definitions). only_failed (flows)
// keeps the cases that ended failed / error / blocked / skipped.
func (s *Service) Rerun(ctx context.Context, actor *auth.Actor, runKey string, in RerunInput) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		old, p, _, err := resolveRun(ctx, tx, actor, runKey, authz.Run, false)
		if err != nil {
			return err
		}
		trigger, err := triggerFor(actor, in.Trigger)
		if err != nil {
			return err
		}
		sp := runSpec{project: p, kind: old.Kind, trigger: trigger, options: old.Options, assigneeID: old.AssigneeID, rerunOf: old.Key}
		if sp.assigneeID == nil {
			id := actor.User.ID
			sp.assigneeID = &id
		}
		switch old.Kind {
		case KindTestCase:
			sp.testCase, err = loadTestCase(ctx, tx, "WHERE tc.id = $1", *old.TestCaseID)
			if err != nil {
				return err
			}
			if sp.testCase == nil || sp.testCase.Deleted {
				return httpx.Unprocessable("The test case of this run no longer exists")
			}
			if err := validateTestCase(sp.testCase); err != nil {
				return err
			}
		case KindFlow:
			sp.flow, err = loadFlow(ctx, tx, "WHERE f.id = $1", *old.FlowID)
			if err != nil {
				return err
			}
			if sp.flow == nil || sp.flow.Deleted {
				return httpx.Unprocessable("The flow of this run no longer exists")
			}
			if err := validateFlow(sp.flow); err != nil {
				return err
			}
			if in.OnlyFailed {
				rows, err := tx.Query(ctx, `SELECT test_case_id FROM run_cases WHERE run_id = $1 AND status IN ('failed', 'error', 'blocked', 'skipped')`, old.ID)
				if err != nil {
					return err
				}
				ids, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
				if err != nil {
					return err
				}
				if len(ids) == 0 {
					return httpx.Unprocessable("No failed cases to rerun")
				}
				sp.onlyCases = map[uuid.UUID]bool{}
				for _, id := range ids {
					sp.onlyCases[id] = true
				}
			}
		}
		if old.EnvironmentID != nil {
			sp.env, err = loadEnv(ctx, tx, "WHERE e.id = $1", *old.EnvironmentID)
			if err != nil {
				return err
			}
		}
		runID, err = s.insertRun(ctx, tx, actor, sp)
		return err
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}

/* ------------------------------------------------------------------ cancel / assignee */

// Cancel: own runs need cancel_own_run, other people's runs cancel_any_run.
// queued / awaiting_manual → cancelled now; running → cancel_requested (the
// worker stops the runner and calls FinishCancelled); final → 409.
func (s *Service) Cancel(ctx context.Context, actor *auth.Actor, runKey string) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		r, p, role, err := resolveRun(ctx, tx, actor, runKey, authz.CancelOwnRun, true)
		if err != nil {
			return err
		}
		runID = r.ID
		if r.TriggeredBy != actor.User.ID && !authz.Can(role, authz.CancelAnyRun, actor.User.SystemRole) {
			return httpx.Forbidden("Only maintainers can cancel other people's runs")
		}
		if IsFinal(r.Status) {
			return httpx.Conflict("Run has already finished")
		}
		if r.Status == StatusQueued || r.Status == StatusAwaitingManual {
			if err := FinishCancelled(ctx, tx, r.ID); err != nil {
				return err
			}
		} else if !r.CancelRequested {
			if _, err := tx.Exec(ctx, `UPDATE runs SET cancel_requested = true, updated_at = now() WHERE id = $1`, r.ID); err != nil {
				return err
			}
			if err := events.Notify(ctx, tx, events.Event{Type: events.RunUpdated, RunKey: r.Key, Status: r.Status}); err != nil {
				return err
			}
		}
		return audit.Record(ctx, tx, actor, "run.cancel", "run", r.Key, &p.ID, audit.Meta{"status": r.Status})
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}

// SetAssignee changes who executes the manual part (reassign_manual).
func (s *Service) SetAssignee(ctx context.Context, actor *auth.Actor, runKey, userID string) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		r, p, _, err := resolveRun(ctx, tx, actor, runKey, authz.ReassignManual, true)
		if err != nil {
			return err
		}
		runID = r.ID
		id, err := checkAssignee(ctx, tx, p.ID, userID)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE runs SET assignee_id = $2, updated_at = now() WHERE id = $1`, r.ID, id); err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, "run.reassign", "run", r.Key, &p.ID, audit.Meta{"assignee_id": id.String()}); err != nil {
			return err
		}
		return events.Notify(ctx, tx, events.Event{Type: events.RunUpdated, RunKey: r.Key, Status: r.Status})
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}

/* ------------------------------------------------------------------ manual execution */

// assertManualEditable mirrors the mock: run awaiting_manual (409), actor is
// the assignee (403), case is the manual case at resume_position (409).
func assertManualEditable(ctx context.Context, q db.Querier, actor *auth.Actor, r runRow, caseID string) (uuid.UUID, error) {
	if r.Status != StatusAwaitingManual {
		return uuid.Nil, httpx.Conflict("Run is not awaiting manual execution")
	}
	if r.AssigneeID == nil || *r.AssigneeID != actor.User.ID {
		return uuid.Nil, httpx.Forbidden("Only the assignee can record manual results")
	}
	notInProgress := httpx.Conflict("This case is not in progress")
	cid, err := uuid.Parse(caseID)
	if err != nil {
		return uuid.Nil, notInProgress
	}
	var (
		execution string
		position  int
	)
	err = q.QueryRow(ctx, `SELECT execution, position FROM run_cases WHERE id = $1 AND run_id = $2`, cid, r.ID).Scan(&execution, &position)
	if db.IsNoRows(err) {
		return uuid.Nil, notInProgress
	}
	if err != nil {
		return uuid.Nil, err
	}
	if execution != ExecutionManual || r.ResumePosition == nil || position != *r.ResumePosition {
		return uuid.Nil, notInProgress
	}
	return cid, nil
}

// ManualResultInput is the PUT …/manual-result body.
type ManualResultInput struct {
	Status       string  `json:"status"`
	ActualResult *string `json:"actual_result"`
}

var manualStatuses = map[string]bool{StepPending: true, StepPassed: true, StepFailed: true, StepBlocked: true, StepSkipped: true}

// SetManualResult records one manual step result (execute_manual + assignee).
func (s *Service) SetManualResult(ctx context.Context, actor *auth.Actor, runKey, caseID, stepID string, in ManualResultInput) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		r, _, _, err := resolveRun(ctx, tx, actor, runKey, authz.ExecuteManual, true)
		if err != nil {
			return err
		}
		runID = r.ID
		cid, err := assertManualEditable(ctx, tx, actor, r, caseID)
		if err != nil {
			return err
		}
		sid, perr := uuid.Parse(stepID)
		var exists bool
		if perr == nil {
			if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM run_steps WHERE id = $1 AND run_case_id = $2)`, sid, cid).Scan(&exists); err != nil {
				return err
			}
		}
		if !exists {
			return httpx.NotFound("Step not found")
		}
		if !manualStatuses[in.Status] {
			return httpx.BadRequest("Invalid step status", httpx.Field("status", "Must be one of: pending, passed, failed, blocked, skipped"))
		}
		var actual *string
		if in.ActualResult != nil && *in.ActualResult != "" {
			actual = in.ActualResult
		}
		if _, err := tx.Exec(ctx, `
			UPDATE run_steps SET status = $2,
				actual_result = CASE WHEN $3 THEN $4 ELSE actual_result END
			WHERE id = $1`, sid, in.Status, in.ActualResult != nil, actual); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE run_cases SET status = 'running', started_at = COALESCE(started_at, now()), executed_by = $2
			WHERE id = $1`, cid, actor.User.ID); err != nil {
			return err
		}
		return events.Notify(ctx, tx, events.Event{Type: events.RunUpdated, RunKey: r.Key, RunCaseID: cid.String(), RunStepID: sid.String(), Status: in.Status})
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}

// AttachmentInput is an uploaded file for a manual case.
type AttachmentInput struct {
	Name      string
	MIME      string
	Size      int64 // -1 when unknown
	Body      io.Reader
	RunStepID string // optional
}

// AddAttachment stores a tester attachment (kind attachment) on the manual
// case in progress. Files over MaxAttachmentBytes → 413 too_large.
func (s *Service) AddAttachment(ctx context.Context, actor *auth.Actor, runKey, caseID string, in AttachmentInput) (artifacts.Artifact, error) {
	if in.Size > MaxAttachmentBytes {
		return artifacts.Artifact{}, tooLarge()
	}
	var (
		saved     artifacts.Artifact
		projectID uuid.UUID
		runID     uuid.UUID
	)
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		r, p, _, err := resolveRun(ctx, tx, actor, runKey, authz.ExecuteManual, true)
		if err != nil {
			return err
		}
		projectID, runID = p.ID, r.ID
		cid, err := assertManualEditable(ctx, tx, actor, r, caseID)
		if err != nil {
			return err
		}
		var stepID *uuid.UUID
		if v := strings.TrimSpace(in.RunStepID); v != "" {
			sid, perr := uuid.Parse(v)
			var ok bool
			if perr == nil {
				if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM run_steps WHERE id = $1 AND run_case_id = $2)`, sid, cid).Scan(&ok); err != nil {
					return err
				}
			}
			if !ok {
				return httpx.BadRequest("Step not found in this case", httpx.Field("run_step_id", "Step not found in this case"))
			}
			stepID = &sid
		}
		body := &limitedReader{r: in.Body, left: MaxAttachmentBytes}
		uid := actor.User.ID
		saved, err = artifacts.SaveWith(ctx, tx, s.store, artifacts.Meta{
			ProjectID: p.ID, RunID: r.ID, RunCaseID: &cid, RunStepID: stepID,
			Kind: artifacts.KindAttachment, Name: in.Name, MIME: in.MIME, UploadedBy: &uid,
		}, body, -1)
		if body.exceeded {
			return tooLarge()
		}
		if err != nil {
			return err
		}
		return events.Notify(ctx, tx, events.Event{Type: events.RunUpdated, RunKey: r.Key, RunCaseID: cid.String(), Status: r.Status})
	})
	if err != nil {
		if saved.ID != uuid.Nil {
			_ = s.store.Delete(context.WithoutCancel(ctx), artifacts.StorageKey(projectID, runID, saved.ID, saved.Name))
		}
		return artifacts.Artifact{}, err
	}
	return saved, nil
}

func tooLarge() *httpx.APIError {
	return httpx.NewError(http.StatusRequestEntityTooLarge, httpx.CodeTooLarge, "Maximum file size is 25 MB")
}

// limitedReader fails once more than left bytes are read.
type limitedReader struct {
	r        io.Reader
	left     int64
	exceeded bool
}

var errTooLarge = errors.New("attachment too large")

func (l *limitedReader) Read(p []byte) (int, error) {
	if int64(len(p)) > l.left+1 {
		p = p[:l.left+1]
	}
	n, err := l.r.Read(p)
	l.left -= int64(n)
	if l.left < 0 {
		l.exceeded = true
		return 0, errTooLarge
	}
	return n, err
}

// CompleteManual finishes the manual case in progress: 409 while a step is
// pending; case status error > failed > blocked > (all skipped → skipped) >
// passed; then Continue (finalize, next manual case, or queue the next
// automated segment for the worker).
func (s *Service) CompleteManual(ctx context.Context, actor *auth.Actor, runKey, caseID string) (Run, error) {
	var runID uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		r, _, _, err := resolveRun(ctx, tx, actor, runKey, authz.ExecuteManual, true)
		if err != nil {
			return err
		}
		runID = r.ID
		cid, err := assertManualEditable(ctx, tx, actor, r, caseID)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT status FROM run_steps WHERE run_case_id = $1 ORDER BY position`, cid)
		if err != nil {
			return err
		}
		statuses, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, st := range statuses {
			if st == StepPending {
				return httpx.Conflict("Some steps are not marked yet")
			}
		}
		status := CaseStatusFromSteps(statuses)
		if _, err := tx.Exec(ctx, `
			UPDATE run_cases SET status = $2,
				executed_by = COALESCE(executed_by, $3),
				started_at = COALESCE(started_at, $4, now()),
				finished_at = now(),
				duration_ms = (EXTRACT(EPOCH FROM (now() - COALESCE(started_at, $4, now()))) * 1000)::int
			WHERE id = $1`, cid, status, actor.User.ID, r.StartedAt); err != nil {
			return err
		}
		if err := events.Notify(ctx, tx, events.Event{Type: events.CaseFinished, RunKey: r.Key, RunCaseID: cid.String(), Status: status}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE runs SET resume_position = NULL, updated_at = now() WHERE id = $1`, r.ID); err != nil {
			return err
		}
		_, err = Continue(ctx, tx, s.enq, r.ID)
		return err
	})
	if err != nil {
		return Run{}, err
	}
	return loadRun(ctx, s.pool, runID)
}
