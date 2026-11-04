package projects

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Member is the OpenAPI Member schema.
type Member struct {
	User    auth.UserRef `json:"user"`
	Role    authz.Role   `json:"role"`
	AddedAt time.Time    `json:"added_at"`
}

const memberSelect = `
SELECT pm.user_id, u.name, u.email, pm.role, pm.added_at
FROM project_members pm
LEFT JOIN users u ON u.id = pm.user_id
`

func scanMember(row pgx.Row) (Member, error) {
	var (
		m           Member
		uid         uuid.UUID
		name, email *string
		added       time.Time
	)
	if err := row.Scan(&uid, &name, &email, &m.Role, &added); err != nil {
		return Member{}, err
	}
	m.User = auth.NewUserRef(&uid, name, email)
	m.AddedAt = added.UTC()
	return m, nil
}

func errMemberNotFound() error { return httpx.NotFound("Member not found") }

func errLastMaintainer() error {
	return httpx.BadRequest("A project needs at least one maintainer")
}

func invalidRole() error {
	return httpx.BadRequest("Invalid role", httpx.Field("role", "Use maintainer, editor or viewer"))
}

// Members lists the project's members (any role), oldest first.
func (s *Service) Members(ctx context.Context, actor *auth.Actor, key string) ([]Member, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, key, authz.View)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, memberSelect+` WHERE pm.project_id = $1 ORDER BY pm.added_at, pm.user_id`, p.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Member{}
	for rows.Next() {
		m, err := scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AssignableUsers lists active users that are not yet members (maintainers).
func (s *Service) AssignableUsers(ctx context.Context, actor *auth.Actor, key string) ([]auth.UserRef, error) {
	p, _, err := authz.ProjectAccess(ctx, s.pool, actor, key, authz.ManageMembers)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT u.id, u.name, u.email FROM users u
		WHERE u.status = 'active'
		  AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = $1 AND pm.user_id = u.id)
		ORDER BY lower(u.name), u.created_at`, p.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []auth.UserRef{}
	for rows.Next() {
		var (
			id          uuid.UUID
			name, email string
		)
		if err := rows.Scan(&id, &name, &email); err != nil {
			return nil, err
		}
		out = append(out, auth.NewUserRef(&id, &name, &email))
	}
	return out, rows.Err()
}

// AddMemberInput is the POST /projects/{key}/members body.
type AddMemberInput struct {
	UserID string     `json:"user_id"`
	Role   authz.Role `json:"role"`
}

// lockProject serialises membership changes of one project so the
// "at least one maintainer" check cannot race.
func lockProject(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, id)
	return err
}

// AddMember adds an existing (non-disabled) user with a role.
func (s *Service) AddMember(ctx context.Context, actor *auth.Actor, key string, in AddMemberInput) (Member, error) {
	var out Member
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageMembers)
		if err != nil {
			return err
		}
		if !in.Role.Valid() {
			return invalidRole()
		}
		userID, err := uuid.Parse(in.UserID)
		notFound := httpx.BadRequest("User not found", httpx.Field("user_id", "User not found"))
		if err != nil {
			return notFound
		}
		var status string
		err = tx.QueryRow(ctx, `SELECT status FROM users WHERE id = $1`, userID).Scan(&status)
		if db.IsNoRows(err) {
			return notFound
		}
		if err != nil {
			return err
		}
		if status == auth.StatusDisabled {
			return httpx.BadRequest("User is disabled", httpx.Field("user_id", "User is disabled"))
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
			ON CONFLICT (project_id, user_id) DO NOTHING`, p.ID, userID, in.Role)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return httpx.Conflict("User is already a member")
		}
		if out, err = scanMember(tx.QueryRow(ctx, memberSelect+` WHERE pm.project_id = $1 AND pm.user_id = $2`, p.ID, userID)); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, ActionMemberAdd, "project_member", userID.String(), &p.ID, audit.Meta{"role": in.Role})
	})
	return out, err
}

// UpdateMemberInput is the PATCH /projects/{key}/members/{userId} body.
type UpdateMemberInput struct {
	Role authz.Role `json:"role"`
}

// UpdateMember changes a member's role; the last maintainer cannot be demoted.
func (s *Service) UpdateMember(ctx context.Context, actor *auth.Actor, key, userIDParam string, in UpdateMemberInput) (Member, error) {
	var out Member
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageMembers)
		if err != nil {
			return err
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		cur, userID, err := memberRole(ctx, tx, p.ID, userIDParam)
		if err != nil {
			return err
		}
		if !in.Role.Valid() {
			return invalidRole()
		}
		if cur == authz.RoleMaintainer && in.Role != authz.RoleMaintainer {
			if err := requireOtherMaintainer(ctx, tx, p.ID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2`, p.ID, userID, in.Role); err != nil {
			return err
		}
		if out, err = scanMember(tx.QueryRow(ctx, memberSelect+` WHERE pm.project_id = $1 AND pm.user_id = $2`, p.ID, userID)); err != nil {
			return err
		}
		if cur == in.Role {
			return nil
		}
		return audit.Record(ctx, tx, actor, ActionMemberUpdate, "project_member", userID.String(), &p.ID,
			audit.Meta{"role": map[string]authz.Role{"from": cur, "to": in.Role}})
	})
	return out, err
}

// RemoveMember removes a member; the last maintainer cannot be removed.
func (s *Service) RemoveMember(ctx context.Context, actor *auth.Actor, key, userIDParam string) error {
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.ManageMembers)
		if err != nil {
			return err
		}
		if err := lockProject(ctx, tx, p.ID); err != nil {
			return err
		}
		cur, userID, err := memberRole(ctx, tx, p.ID, userIDParam)
		if err != nil {
			return err
		}
		if cur == authz.RoleMaintainer {
			if err := requireOtherMaintainer(ctx, tx, p.ID); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, p.ID, userID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, ActionMemberRemove, "project_member", userID.String(), &p.ID, audit.Meta{"role": cur})
	})
}

func memberRole(ctx context.Context, tx pgx.Tx, projectID uuid.UUID, userIDParam string) (authz.Role, uuid.UUID, error) {
	userID, err := uuid.Parse(userIDParam)
	if err != nil {
		return "", uuid.Nil, errMemberNotFound()
	}
	var role authz.Role
	err = tx.QueryRow(ctx, `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, userID).Scan(&role)
	if db.IsNoRows(err) {
		return "", uuid.Nil, errMemberNotFound()
	}
	return role, userID, err
}

// requireOtherMaintainer fails when the project has exactly one maintainer
// (called when that maintainer is being demoted or removed).
func requireOtherMaintainer(ctx context.Context, tx pgx.Tx, projectID uuid.UUID) error {
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM project_members WHERE project_id = $1 AND role = 'maintainer'`, projectID).Scan(&n); err != nil {
		return err
	}
	if n <= 1 {
		return errLastMaintainer()
	}
	return nil
}
