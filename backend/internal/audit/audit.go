// Package audit writes audit_logs rows (docs/05: login success/failure, user /
// role / member changes, environment & secret changes without values, test
// case & flow create/update/delete, run create/cancel, token create/revoke).
//
// Call Record inside the same transaction as the change it describes so the
// log and the data commit together.
package audit

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// Principal identifies who performed an action. *auth.Actor implements it; a
// nil *auth.Actor is allowed and records an anonymous entry.
type Principal interface {
	AuditIdentity() (userID, tokenID *uuid.UUID)
}

// Meta is free-form context stored as jsonb. Never put secrets or passwords in it.
type Meta map[string]any

// Record inserts one audit log entry. actor may be nil (anonymous / system).
// entityID is a uuid or a display key (e.g. SHOP-T12); projectID is optional.
func Record(ctx context.Context, q db.Querier, actor Principal, action, entityType, entityID string, projectID *uuid.UUID, meta Meta) error {
	var userID, tokenID *uuid.UUID
	if actor != nil {
		userID, tokenID = actor.AuditIdentity()
	}
	if meta == nil {
		meta = Meta{}
	}
	raw, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("audit meta: %w", err)
	}
	_, err = q.Exec(ctx, `
		INSERT INTO audit_logs (id, actor_user_id, actor_token_id, project_id, action, entity_type, entity_id, meta)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		db.NewID(), userID, tokenID, projectID, action, entityType, entityID, raw)
	if err != nil {
		return fmt.Errorf("audit %s: %w", action, err)
	}
	return nil
}

// User is a Principal for a known user without an authenticated actor
// (e.g. a failed login attempt for an existing account).
type User uuid.UUID

// AuditIdentity implements Principal.
func (u User) AuditIdentity() (*uuid.UUID, *uuid.UUID) {
	id := uuid.UUID(u)
	return &id, nil
}

// Action names used by the foundation packages. Later packages add their own
// following the "<entity>.<verb>" pattern (test_case.update, run.cancel, ...).
const (
	ActionLogin          = "auth.login"
	ActionLoginFailed    = "auth.login_failed"
	ActionLogout         = "auth.logout"
	ActionInviteAccepted = "auth.invite_accepted"
	ActionUserCreate     = "user.create"
	ActionUserUpdate     = "user.update"
	ActionUserInviteLink = "user.invite_link"
	ActionPasswordChange = "user.password_change"
	ActionTokenCreate    = "api_token.create"
	ActionTokenRevoke    = "api_token.revoke"
)
