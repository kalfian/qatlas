// Package authz is the RBAC matrix (1:1 port of web/src/lib/permissions.ts)
// plus ProjectAccess, the single entry point every project-scoped service
// method uses to resolve a project and check role + token scope.
package authz

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Role is a project role.
type Role string

// Project roles.
const (
	RoleMaintainer Role = "maintainer"
	RoleEditor     Role = "editor"
	RoleViewer     Role = "viewer"
)

// Roles lists every project role (strongest first).
var Roles = []Role{RoleMaintainer, RoleEditor, RoleViewer}

// Valid reports whether r is a known role.
func (r Role) Valid() bool { return slices.Contains(Roles, r) }

// Action is a project action (ProjectAction in permissions.ts).
type Action string

// Project actions.
const (
	View               Action = "view"
	EditTests          Action = "edit_tests"
	Run                Action = "run"
	CancelOwnRun       Action = "cancel_own_run"
	CancelAnyRun       Action = "cancel_any_run"
	ExecuteManual      Action = "execute_manual"
	ReassignManual     Action = "reassign_manual"
	ManageEnvironments Action = "manage_environments"
	ManageMembers      Action = "manage_members"
	ManageSettings     Action = "manage_settings"
)

var matrix = map[Action][]Role{
	View:               {RoleViewer, RoleEditor, RoleMaintainer},
	EditTests:          {RoleEditor, RoleMaintainer},
	Run:                {RoleEditor, RoleMaintainer},
	CancelOwnRun:       {RoleEditor, RoleMaintainer},
	CancelAnyRun:       {RoleMaintainer},
	ExecuteManual:      {RoleEditor, RoleMaintainer},
	ReassignManual:     {RoleMaintainer},
	ManageEnvironments: {RoleMaintainer},
	ManageMembers:      {RoleMaintainer},
	ManageSettings:     {RoleMaintainer},
}

// Actions lists every action (for exhaustive tests).
func Actions() []Action {
	out := make([]Action, 0, len(matrix))
	for a := range matrix {
		out = append(out, a)
	}
	slices.Sort(out)
	return out
}

// Can reports whether role may perform action. System admins may do anything;
// an empty role (no access) may do nothing. Mirrors permissions.ts `can`.
func Can(role Role, action Action, systemRole string) bool {
	if systemRole == auth.SystemRoleAdmin {
		return true
	}
	if role == "" {
		return false
	}
	return slices.Contains(matrix[action], role)
}

// Scope is the API-token scope an action needs (docs/13: read for viewing,
// write for mutations, run for creating/cancelling runs and manual results).
func Scope(action Action) string {
	switch action {
	case View:
		return auth.ScopeRead
	case Run, CancelOwnRun, CancelAnyRun, ExecuteManual:
		return auth.ScopeRun
	default:
		return auth.ScopeWrite
	}
}

// EffectiveRole is the membership role, or maintainer for admins without
// membership, or "" (no access). Mirrors the mock's roleIn.
func EffectiveRole(member *string, systemRole string) Role {
	if member != nil {
		return Role(*member)
	}
	if systemRole == auth.SystemRoleAdmin {
		return RoleMaintainer
	}
	return ""
}

// Project is the projects row returned by ProjectAccess.
type Project struct {
	ID                    uuid.UUID
	Key                   string
	Name                  string
	Description           string
	ArchivedAt            *time.Time
	CreatedBy             *uuid.UUID
	DefaultRunOptions     json.RawMessage
	ArtifactRetentionDays int
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// ProjectColumns selects a Project from a table aliased "p" (scan order of ProjectAccess).
const ProjectColumns = `p.id, p.key, p.name, p.description, p.archived_at, p.created_by, p.default_run_options, p.artifact_retention_days, p.created_at, p.updated_at`

// ProjectAccess resolves projectKey for actor and checks action, exactly like
// the mock's requireProject:
//
//   - unknown project, no effective role, or outside the token's project list → 404 not_found
//   - role does not allow the action → 403 forbidden
//   - API token lacks Scope(action) → 403 forbidden
//
// Pass a pgx.Tx as q to resolve inside a transaction.
func ProjectAccess(ctx context.Context, q db.Querier, actor *auth.Actor, projectKey string, action Action) (Project, Role, error) {
	if actor == nil {
		return Project{}, "", auth.ErrUnauthenticated()
	}
	key := strings.ToUpper(strings.TrimSpace(projectKey))
	notFound := httpx.NotFound("Project " + key + " not found")
	var (
		p      Project
		member *string
	)
	err := q.QueryRow(ctx, `
		SELECT `+ProjectColumns+`, pm.role
		FROM projects p
		LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $2
		WHERE p.key = $1`, key, actor.User.ID).
		Scan(&p.ID, &p.Key, &p.Name, &p.Description, &p.ArchivedAt, &p.CreatedBy, &p.DefaultRunOptions,
			&p.ArtifactRetentionDays, &p.CreatedAt, &p.UpdatedAt, &member)
	if db.IsNoRows(err) {
		return Project{}, "", notFound
	}
	if err != nil {
		return Project{}, "", err
	}
	role := EffectiveRole(member, actor.User.SystemRole)
	if role == "" || !actor.CanAccessProject(p.ID) {
		return Project{}, "", notFound
	}
	if !Can(role, action, actor.User.SystemRole) {
		return Project{}, "", httpx.Forbidden("Your role does not allow this action")
	}
	if err := actor.RequireScope(Scope(action)); err != nil {
		return Project{}, "", err
	}
	return p, role, nil
}

// ProjectKeyOf returns the project key prefix of an entity key
// ("SHOP-T12" → "SHOP"), like the mock's projectOfKey.
func ProjectKeyOf(entityKey string) string {
	k, _, _ := strings.Cut(entityKey, "-")
	return strings.ToUpper(k)
}

// ParseEntityKey splits "SHOP-T12" with kind 'T' into ("SHOP", 12, true).
// Kinds: 'T' test case, 'F' flow, 'R' run.
func ParseEntityKey(entityKey string, kind byte) (projectKey string, seq int, ok bool) {
	prefix, rest, found := strings.Cut(strings.ToUpper(strings.TrimSpace(entityKey)), "-")
	if !found || len(rest) < 2 || rest[0] != kind || prefix == "" {
		return "", 0, false
	}
	n, err := strconv.Atoi(rest[1:])
	if err != nil || n < 1 {
		return "", 0, false
	}
	return prefix, n, true
}
