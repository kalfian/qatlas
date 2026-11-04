package runs

// State transitions shared by the HTTP service and the worker. Every helper
// takes a db.Querier / pgx.Tx so callers compose them inside their own
// transaction; events.Notify is issued on the same querier (delivered on commit).

import (
	"context"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/jobs"
)

// DefaultErrorMessage is set on runs that end in status error without a message.
const DefaultErrorMessage = "Infrastructure error during execution"

// CaseStatusFromSteps is the mock's caseStatusFromSteps:
// error > failed > blocked > (all skipped → skipped) > passed.
func CaseStatusFromSteps(steps []string) string {
	switch {
	case slices.Contains(steps, StepError):
		return StepError
	case slices.Contains(steps, StepFailed):
		return StepFailed
	case slices.Contains(steps, StepBlocked):
		return StepBlocked
	}
	if len(steps) > 0 && !slices.ContainsFunc(steps, func(s string) bool { return s != StepSkipped }) {
		return StepSkipped
	}
	return StepPassed
}

// RunStatusFromCases is the mock's finalizeRun: error > failed > blocked > passed.
func RunStatusFromCases(cases []string) string {
	switch {
	case slices.Contains(cases, StepError):
		return StatusError
	case slices.Contains(cases, StepFailed):
		return StatusFailed
	case slices.Contains(cases, StepBlocked):
		return StatusBlocked
	}
	return StatusPassed
}

func runKeyOf(ctx context.Context, q db.Querier, runID uuid.UUID) (string, error) {
	var key string
	err := q.QueryRow(ctx, `SELECT p.key || '-R' || r.seq FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`, runID).Scan(&key)
	return key, err
}

// SyncLastRunStatus copies the run's status / queued_at onto its target
// (test_cases.last_run_status for test case runs, flows.last_run_status for
// flow runs) unless a newer run already touched the target. Call it after
// every run status change.
func SyncLastRunStatus(ctx context.Context, q db.Querier, runID uuid.UUID) error {
	if _, err := q.Exec(ctx, `
		UPDATE test_cases t SET last_run_status = r.status, last_run_at = r.queued_at
		FROM runs r
		WHERE r.id = $1 AND r.kind = 'test_case' AND t.id = r.test_case_id
		  AND (t.last_run_at IS NULL OR t.last_run_at <= r.queued_at)`, runID); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `
		UPDATE flows f SET last_run_status = r.status, last_run_at = r.queued_at
		FROM runs r
		WHERE r.id = $1 AND r.kind = 'flow' AND f.id = r.flow_id
		  AND (f.last_run_at IS NULL OR f.last_run_at <= r.queued_at)`, runID)
	return err
}

// FinalizeRun computes the final status from the case statuses (mock
// finalizeRun), sets finished_at, clears resume_position, and notifies
// run_finished. Returns the final status.
func FinalizeRun(ctx context.Context, q db.Querier, runID uuid.UUID) (string, error) {
	rows, err := q.Query(ctx, `SELECT status FROM run_cases WHERE run_id = $1`, runID)
	if err != nil {
		return "", err
	}
	statuses, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return "", err
	}
	status := RunStatusFromCases(statuses)
	var key string
	err = q.QueryRow(ctx, `
		UPDATE runs r SET status = $2, finished_at = now(), resume_position = NULL, updated_at = now(),
			started_at = COALESCE(r.started_at, now()),
			error_message = CASE WHEN $2 = 'error' THEN COALESCE(r.error_message, $3) ELSE r.error_message END
		FROM projects p WHERE r.id = $1 AND p.id = r.project_id
		RETURNING p.key || '-R' || r.seq`, runID, status, DefaultErrorMessage).Scan(&key)
	if err != nil {
		return "", err
	}
	if err := SyncLastRunStatus(ctx, q, runID); err != nil {
		return "", err
	}
	return status, events.Notify(ctx, q, events.Event{Type: events.RunFinished, RunKey: key, Status: status})
}

// FinishCancelled marks every pending/running case (and its pending/running
// steps) skipped and the run cancelled. Used by POST /cancel for queued /
// awaiting_manual runs and by the worker once a cancel_requested run stopped.
func FinishCancelled(ctx context.Context, q db.Querier, runID uuid.UUID) error {
	if _, err := q.Exec(ctx, `
		UPDATE run_steps s SET status = 'skipped'
		FROM run_cases c
		WHERE c.id = s.run_case_id AND c.run_id = $1
		  AND c.status IN ('pending', 'running') AND s.status IN ('pending', 'running')`, runID); err != nil {
		return err
	}
	if _, err := q.Exec(ctx, `UPDATE run_cases SET status = 'skipped' WHERE run_id = $1 AND status IN ('pending', 'running')`, runID); err != nil {
		return err
	}
	var key string
	err := q.QueryRow(ctx, `
		UPDATE runs r SET status = 'cancelled', finished_at = now(), resume_position = NULL, updated_at = now()
		FROM projects p WHERE r.id = $1 AND p.id = r.project_id
		RETURNING p.key || '-R' || r.seq`, runID).Scan(&key)
	if err != nil {
		return err
	}
	if err := SyncLastRunStatus(ctx, q, runID); err != nil {
		return err
	}
	return events.Notify(ctx, q, events.Event{Type: events.RunFinished, RunKey: key, Status: StatusCancelled})
}

// Continue decides what happens after a case (or an automated segment)
// finished and nothing is running:
//
//  1. flow with stop_on_failure and an earlier failed/error/blocked case that
//     is not continue_on_failure → every remaining pending case is skipped;
//  2. no pending case left → FinalizeRun;
//  3. next pending case is manual → awaiting_manual, resume_position = its position;
//  4. otherwise → queued, resume_position = its position, enq.EnqueueRun in tx.
//
// Returns the new run status. tx must hold the run row lock (SELECT … FOR UPDATE)
// or otherwise be the only writer.
func Continue(ctx context.Context, tx pgx.Tx, enq jobs.Enqueuer, runID uuid.UUID) (string, error) {
	var (
		kind string
		stop bool
	)
	if err := tx.QueryRow(ctx, `SELECT kind, stop_on_failure FROM runs WHERE id = $1`, runID).Scan(&kind, &stop); err != nil {
		return "", err
	}
	if kind == KindFlow && stop {
		if _, err := tx.Exec(ctx, `
			WITH blocked AS (
				SELECT EXISTS (SELECT 1 FROM run_cases WHERE run_id = $1
					AND status IN ('failed', 'error', 'blocked') AND NOT continue_on_failure) AS yes
			), skipped AS (
				UPDATE run_cases SET status = 'skipped'
				WHERE run_id = $1 AND status = 'pending' AND (SELECT yes FROM blocked)
				RETURNING id
			)
			UPDATE run_steps SET status = 'skipped'
			WHERE run_case_id IN (SELECT id FROM skipped) AND status IN ('pending', 'running')`, runID); err != nil {
			return "", err
		}
	}
	var (
		pos       int
		execution string
	)
	err := tx.QueryRow(ctx, `SELECT position, execution FROM run_cases WHERE run_id = $1 AND status = 'pending' ORDER BY position LIMIT 1`, runID).Scan(&pos, &execution)
	if db.IsNoRows(err) {
		return FinalizeRun(ctx, tx, runID)
	}
	if err != nil {
		return "", err
	}
	key, err := runKeyOf(ctx, tx, runID)
	if err != nil {
		return "", err
	}
	status, evType := StatusQueued, events.RunUpdated
	if execution == ExecutionManual {
		status, evType = StatusAwaitingManual, events.AwaitingManual
	}
	if _, err := tx.Exec(ctx, `
		UPDATE runs SET status = $2, resume_position = $3, started_at = COALESCE(started_at, now()), updated_at = now()
		WHERE id = $1`, runID, status, pos); err != nil {
		return "", err
	}
	if status == StatusQueued {
		if err := enq.EnqueueRun(ctx, tx, runID); err != nil {
			return "", fmt.Errorf("enqueue run: %w", err)
		}
	}
	if err := SyncLastRunStatus(ctx, tx, runID); err != nil {
		return "", err
	}
	return status, events.Notify(ctx, tx, events.Event{Type: evType, RunKey: key, Status: status})
}
