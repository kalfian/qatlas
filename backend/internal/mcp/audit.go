package mcp

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// ActionToolCall is the audit action of every mutating MCP tool call. The
// service already wrote its own entry (test_case.create, run.create with
// trigger=mcp, …) in its transaction; this one records that it came through
// MCP (meta.trigger = "mcp", meta.tool) with actor_token_id.
const ActionToolCall = "mcp.tool_call"

// auditCall records a successful mutating tool call. Failures are logged, not
// returned: the change itself is already committed.
func (s *Server) auditCall(ctx context.Context, actor *auth.Actor, tool, entityType, entityKey string) {
	var projectID *uuid.UUID
	var id uuid.UUID
	err := s.pool.QueryRow(ctx, `SELECT id FROM projects WHERE key = $1`, authz.ProjectKeyOf(entityKey)).Scan(&id)
	if err == nil {
		projectID = &id
	} else if !db.IsNoRows(err) {
		s.log.WarnContext(ctx, "mcp audit: project lookup failed", "err", err)
	}
	if err := audit.Record(ctx, s.pool, actor, ActionToolCall, entityType, entityKey, projectID,
		audit.Meta{"tool": tool, "trigger": runs.TriggerMCP}); err != nil {
		s.log.ErrorContext(ctx, "mcp audit failed", "tool", tool, "entity", entityKey, "err", err)
	}
}

// checkRunLimit enforces the per-token cap on MCP runs that are queued or
// running. Call it while holding runLock(tokenID).
func (s *Server) checkRunLimit(ctx context.Context, actor *auth.Actor) error {
	if actor.TokenID == nil {
		return nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT p.key || '-R' || r.seq
		FROM runs r JOIN projects p ON p.id = r.project_id
		WHERE r.api_token_id = $1 AND r.trigger = $2 AND r.status IN ('queued', 'running')
		ORDER BY r.queued_at`, *actor.TokenID, runs.TriggerMCP)
	if err != nil {
		return err
	}
	active, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	if len(active) < s.maxRuns {
		return nil
	}
	return withHint(httpx.NewError(http.StatusTooManyRequests, httpx.CodeRateLimited,
		fmt.Sprintf("This API token already has %d MCP runs queued or running (%s); the limit is %d", len(active), strings.Join(active, ", "), s.maxRuns)),
		"Wait for one of them with wait_for_run (or cancel one with cancel_run), then start the new run.")
}
