// Package runs owns run creation (snapshots, run_cases/run_steps, transactional
// enqueue), manual execution, cancel/rerun, the Run / RunSummary DTOs and the
// state transitions shared with the worker (state.go). REST handlers live in
// handlers.go; MCP calls the Service methods directly.
package runs

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
)

// Counts is the OpenAPI Counts schema (mock runCounts/bump: failed includes error).
type Counts struct {
	Total   int `json:"total"`
	Passed  int `json:"passed"`
	Failed  int `json:"failed"`
	Blocked int `json:"blocked"`
	Skipped int `json:"skipped"`
	Other   int `json:"other"`
}

// Target is RunSummary.target.
type Target struct {
	ID    string `json:"id"`
	Key   string `json:"key"`
	Title string `json:"title"`
}

// EnvironmentRef is RunSummary.environment.
type EnvironmentRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SummaryCounts is RunSummary.summary.
type SummaryCounts struct {
	Cases Counts `json:"cases"`
	Steps Counts `json:"steps"`
}

// RunSummary is the OpenAPI RunSummary schema.
type RunSummary struct {
	ID          uuid.UUID       `json:"id"`
	Key         string          `json:"key"`
	ProjectKey  string          `json:"project_key"`
	Kind        string          `json:"kind"`
	Target      Target          `json:"target"`
	Environment *EnvironmentRef `json:"environment"`
	Status      string          `json:"status"`
	Trigger     string          `json:"trigger"`
	TriggeredBy auth.UserRef    `json:"triggered_by"`
	Assignee    *auth.UserRef   `json:"assignee"`
	HasManual   bool            `json:"has_manual"`
	Summary     SummaryCounts   `json:"summary"`
	QueuedAt    time.Time       `json:"queued_at"`
	StartedAt   *time.Time      `json:"started_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
	DurationMS  *int64          `json:"duration_ms"`
}

// summarySelect produces one RunSummary row per run. Append WHERE / ORDER BY /
// LIMIT using the "r" (runs) and "p" (projects) aliases.
const summarySelect = `
SELECT r.id, p.key || '-R' || r.seq, p.key, r.kind,
	COALESCE(r.test_case_id, r.flow_id), r.target_key, r.target_title,
	r.environment_id, r.environment_name, r.status, r.trigger,
	r.triggered_by, tb.name, tb.email,
	r.assignee_id, asg.name, asg.email,
	EXISTS (SELECT 1 FROM run_cases x WHERE x.run_id = r.id AND x.execution = 'manual'),
	cc.total, cc.passed, cc.failed, cc.blocked, cc.skipped, cc.other,
	sc.total, sc.passed, sc.failed, sc.blocked, sc.skipped, sc.other,
	r.queued_at, r.started_at, r.finished_at,
	(EXTRACT(EPOCH FROM (COALESCE(r.finished_at, now()) - r.started_at)) * 1000)::bigint
FROM runs r
JOIN projects p ON p.id = r.project_id
LEFT JOIN users tb ON tb.id = r.triggered_by
LEFT JOIN users asg ON asg.id = r.assignee_id
LEFT JOIN LATERAL (
	SELECT count(*)::int AS total,
		count(*) FILTER (WHERE c.status = 'passed')::int AS passed,
		count(*) FILTER (WHERE c.status IN ('failed', 'error'))::int AS failed,
		count(*) FILTER (WHERE c.status = 'blocked')::int AS blocked,
		count(*) FILTER (WHERE c.status = 'skipped')::int AS skipped,
		count(*) FILTER (WHERE c.status NOT IN ('passed', 'failed', 'error', 'blocked', 'skipped'))::int AS other
	FROM run_cases c WHERE c.run_id = r.id
) cc ON true
LEFT JOIN LATERAL (
	SELECT count(*)::int AS total,
		count(*) FILTER (WHERE s.status = 'passed')::int AS passed,
		count(*) FILTER (WHERE s.status IN ('failed', 'error'))::int AS failed,
		count(*) FILTER (WHERE s.status = 'blocked')::int AS blocked,
		count(*) FILTER (WHERE s.status = 'skipped')::int AS skipped,
		count(*) FILTER (WHERE s.status NOT IN ('passed', 'failed', 'error', 'blocked', 'skipped'))::int AS other
	FROM run_steps s JOIN run_cases c ON c.id = s.run_case_id WHERE c.run_id = r.id
) sc ON true
`

// QuerySummaries runs summarySelect + tail (e.g. "WHERE r.project_id = $1
// ORDER BY r.queued_at DESC LIMIT $2 OFFSET $3") and scans RunSummary rows.
func QuerySummaries(ctx context.Context, q db.Querier, tail string, args ...any) ([]RunSummary, error) {
	rows, err := q.Query(ctx, summarySelect+tail, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RunSummary{}
	for rows.Next() {
		var (
			s                 RunSummary
			targetID          uuid.UUID
			envID             *uuid.UUID
			envName           *string
			tbID, asgID       *uuid.UUID
			tbName, tbEmail   *string
			asgName, asgEmail *string
			cc, sc            Counts
			durationMS        *int64
			queued            time.Time
			started, finished *time.Time
		)
		if err := rows.Scan(&s.ID, &s.Key, &s.ProjectKey, &s.Kind,
			&targetID, &s.Target.Key, &s.Target.Title,
			&envID, &envName, &s.Status, &s.Trigger,
			&tbID, &tbName, &tbEmail,
			&asgID, &asgName, &asgEmail,
			&s.HasManual,
			&cc.Total, &cc.Passed, &cc.Failed, &cc.Blocked, &cc.Skipped, &cc.Other,
			&sc.Total, &sc.Passed, &sc.Failed, &sc.Blocked, &sc.Skipped, &sc.Other,
			&queued, &started, &finished, &durationMS); err != nil {
			return nil, err
		}
		s.Target.ID = targetID.String()
		if envID != nil {
			name := ""
			if envName != nil {
				name = *envName
			}
			s.Environment = &EnvironmentRef{ID: envID.String(), Name: name}
		}
		s.TriggeredBy = auth.NewUserRef(tbID, tbName, tbEmail)
		if asgID != nil {
			ref := auth.NewUserRef(asgID, asgName, asgEmail)
			s.Assignee = &ref
		}
		s.Summary = SummaryCounts{Cases: cc, Steps: sc}
		s.QueuedAt, s.StartedAt, s.FinishedAt = queued.UTC(), auth.UTCPtr(started), auth.UTCPtr(finished)
		s.DurationMS = durationMS // NULL when not started
		out = append(out, s)
	}
	return out, rows.Err()
}

// ListAwaitingManualFor returns runs awaiting manual execution assigned to
// the user, limited to projects the user can still access, oldest first
// (mock: GET /me/manual-runs).
func ListAwaitingManualFor(ctx context.Context, q db.Querier, actor *auth.Actor) ([]RunSummary, error) {
	return QuerySummaries(ctx, q, `
		WHERE r.status = 'awaiting_manual' AND r.assignee_id = $1
		  AND ($2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = r.project_id AND pm.user_id = $1))
		  AND ($3::uuid[] IS NULL OR r.project_id = ANY ($3))
		ORDER BY r.queued_at ASC, r.id ASC`, actor.User.ID, actor.User.IsAdmin(), actor.ProjectIDs)
}
