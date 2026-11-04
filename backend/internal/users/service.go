// Package users implements /me (profile, tokens, manual tasks) and the admin
// user management endpoints. Business logic lives in Service methods so REST
// handlers and MCP tools share it.
package users

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/runs"
)

// Service implements user-facing account operations.
type Service struct {
	pool *pgxpool.Pool
	auth *auth.Service
}

// New builds the users service.
func New(pool *pgxpool.Pool, authSvc *auth.Service) *Service {
	return &Service{pool: pool, auth: authSvc}
}

// ------------------------------------------------------------------ /me

// Me returns the actor's profile and project roles.
func (s *Service) Me(ctx context.Context, actor *auth.Actor) (auth.Me, error) {
	u, err := auth.LoadUser(ctx, s.pool, actor.User.ID)
	if err != nil {
		return auth.Me{}, err
	}
	return auth.LoadMe(ctx, s.pool, u)
}

// UpdateMeInput is the PATCH /me body (all fields optional).
type UpdateMeInput struct {
	Name            *string `json:"name"`
	Locale          *string `json:"locale"`
	CurrentPassword *string `json:"current_password"`
	NewPassword     *string `json:"new_password"`
}

// UpdateMe changes name / locale / password. An unknown locale is ignored
// (mock behaviour). Changing the password signs out every other session.
func (s *Service) UpdateMe(ctx context.Context, actor *auth.Actor, in UpdateMeInput) (auth.Me, error) {
	var me auth.Me
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		u, err := auth.ScanUser(tx.QueryRow(ctx, `SELECT `+auth.UserColumns+` FROM users u WHERE u.id = $1 FOR UPDATE`, actor.User.ID))
		if err != nil {
			return err
		}
		changed := []string{}
		name, locale, hash := u.Name, u.Locale, u.PasswordHash

		if in.Locale != nil && (*in.Locale == "en" || *in.Locale == "id") && *in.Locale != u.Locale {
			locale = *in.Locale
			changed = append(changed, "locale")
		}
		if in.Name != nil {
			n := strings.TrimSpace(*in.Name)
			if n == "" {
				return httpx.BadRequest("Name is required", httpx.Field("name", "Required"))
			}
			if n != u.Name {
				name = n
				changed = append(changed, "name")
			}
		}
		passwordChanged := false
		if in.NewPassword != nil {
			if actor.ViaToken() {
				return httpx.Forbidden("Changing the password requires a signed-in session")
			}
			if u.PasswordHash != nil {
				cur := ""
				if in.CurrentPassword != nil {
					cur = *in.CurrentPassword
				}
				ok, err := auth.VerifyPassword(cur, *u.PasswordHash)
				if err != nil || !ok {
					return httpx.BadRequest("Current password is incorrect", httpx.Field("current_password", "Current password is incorrect"))
				}
			}
			if len(*in.NewPassword) < auth.MinPasswordLength {
				return httpx.BadRequest("Password must be at least 10 characters", httpx.Field("new_password", "At least 10 characters"))
			}
			h, err := auth.HashPassword(*in.NewPassword)
			if err != nil {
				return err
			}
			hash, passwordChanged = &h, true
		}

		if len(changed) > 0 || passwordChanged {
			u, err = auth.ScanUser(tx.QueryRow(ctx, `
				UPDATE users u SET name = $2, locale = $3, password_hash = $4, updated_at = now()
				WHERE u.id = $1 RETURNING `+auth.UserColumns, u.ID, name, locale, hash))
			if err != nil {
				return err
			}
		}
		if len(changed) > 0 {
			if err := audit.Record(ctx, tx, actor, audit.ActionUserUpdate, "user", u.ID.String(), nil, audit.Meta{"self": true, "fields": changed}); err != nil {
				return err
			}
		}
		if passwordChanged {
			if err := auth.DeleteUserSessions(ctx, tx, u.ID, actor.SessionID); err != nil {
				return err
			}
			if err := audit.Record(ctx, tx, actor, audit.ActionPasswordChange, "user", u.ID.String(), nil, nil); err != nil {
				return err
			}
		}
		me, err = auth.LoadMe(ctx, tx, u)
		return err
	})
	return me, err
}

// ManualRuns lists runs awaiting manual execution assigned to the actor.
func (s *Service) ManualRuns(ctx context.Context, actor *auth.Actor) ([]runs.RunSummary, error) {
	return runs.ListAwaitingManualFor(ctx, s.pool, actor)
}

// ------------------------------------------------------------------ admin

func requireAdmin(actor *auth.Actor) error {
	if !actor.IsAdmin() {
		return httpx.Forbidden("Only admins can do this")
	}
	return nil
}

// ListUsers returns every user sorted by name (admin only).
func (s *Service) ListUsers(ctx context.Context, actor *auth.Actor) ([]auth.UserDTO, error) {
	if err := requireAdmin(actor); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT `+auth.UserColumns+` FROM users u ORDER BY lower(u.name), u.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []auth.UserDTO{}
	for rows.Next() {
		u, err := auth.ScanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u.DTO())
	}
	return out, rows.Err()
}

// CreateUserInput is the POST /admin/users body.
type CreateUserInput struct {
	Email      string `json:"email"`
	Name       string `json:"name"`
	SystemRole string `json:"system_role"`
}

// UserInvite is the OpenAPI UserInvite schema.
type UserInvite struct {
	User      auth.UserDTO `json:"user"`
	InviteURL string       `json:"invite_url"`
	ExpiresAt time.Time    `json:"expires_at"`
}

var emailPattern = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

func validSystemRole(r string) bool { return r == auth.SystemRoleAdmin || r == auth.SystemRoleMember }

// CreateUser creates an invited user and returns a 72 h invite link.
func (s *Service) CreateUser(ctx context.Context, actor *auth.Actor, in CreateUserInput) (UserInvite, error) {
	if err := requireAdmin(actor); err != nil {
		return UserInvite{}, err
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	if !emailPattern.MatchString(email) {
		return UserInvite{}, httpx.BadRequest("Invalid email address", httpx.Field("email", "Invalid email address"))
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return UserInvite{}, httpx.BadRequest("Name is required", httpx.Field("name", "Required"))
	}
	role := in.SystemRole
	if role == "" {
		role = auth.SystemRoleMember
	}
	if !validSystemRole(role) {
		return UserInvite{}, httpx.BadRequest("Invalid system role", httpx.Field("system_role", "Use admin or member"))
	}
	duplicate := func() error {
		return httpx.Conflict("Email is already registered", httpx.Field("email", "Email is already registered"))
	}

	var out UserInvite
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE email = $1)`, email).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return duplicate()
		}
		u, err := auth.ScanUser(tx.QueryRow(ctx, `
			INSERT INTO users AS u (id, email, name, system_role, status) VALUES ($1, $2, $3, $4, 'invited')
			RETURNING `+auth.UserColumns, db.NewID(), email, name, role))
		if db.IsUniqueViolation(err, "users_email_key") {
			return duplicate()
		}
		if err != nil {
			return err
		}
		adminID := actor.User.ID
		token, expires, err := auth.CreateInvite(ctx, tx, u.ID, auth.InviteKindInvite, &adminID)
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, audit.ActionUserCreate, "user", u.ID.String(), nil,
			audit.Meta{"email": email, "system_role": role}); err != nil {
			return err
		}
		out = UserInvite{User: u.DTO(), InviteURL: s.auth.InviteURL(token), ExpiresAt: expires}
		return nil
	})
	return out, err
}

// AdminUpdateUserInput is the PATCH /admin/users/{id} body.
type AdminUpdateUserInput struct {
	Name       *string `json:"name"`
	SystemRole *string `json:"system_role"`
	Status     *string `json:"status"`
}

func errUserNotFound() error { return httpx.NotFound("User not found") }

// UpdateUser changes name / system role / status. Admins cannot disable or
// demote themselves; invited users only become active by accepting the
// invite; disabling revokes every API token, session and open invite link.
func (s *Service) UpdateUser(ctx context.Context, actor *auth.Actor, id string, in AdminUpdateUserInput) (auth.UserDTO, error) {
	if err := requireAdmin(actor); err != nil {
		return auth.UserDTO{}, err
	}
	userID, err := uuid.Parse(id)
	if err != nil {
		return auth.UserDTO{}, errUserNotFound()
	}
	var out auth.UserDTO
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		u, err := auth.ScanUser(tx.QueryRow(ctx, `SELECT `+auth.UserColumns+` FROM users u WHERE u.id = $1 FOR UPDATE`, userID))
		if db.IsNoRows(err) {
			return errUserNotFound()
		}
		if err != nil {
			return err
		}
		if u.ID == actor.User.ID && ((in.Status != nil && *in.Status == auth.StatusDisabled) || (in.SystemRole != nil && *in.SystemRole == auth.SystemRoleMember)) {
			return httpx.BadRequest("You cannot disable or demote your own account")
		}
		name, role, status := u.Name, u.SystemRole, u.Status
		meta := audit.Meta{}
		if in.Name != nil {
			if n := strings.TrimSpace(*in.Name); n != "" && n != u.Name {
				name = n
				meta["name"] = n
			}
		}
		if in.SystemRole != nil {
			if !validSystemRole(*in.SystemRole) {
				return httpx.BadRequest("Invalid system role", httpx.Field("system_role", "Use admin or member"))
			}
			if *in.SystemRole != u.SystemRole {
				role = *in.SystemRole
				meta["system_role"] = map[string]string{"from": u.SystemRole, "to": role}
			}
		}
		if in.Status != nil {
			switch *in.Status {
			case auth.StatusActive:
				if u.Status == auth.StatusInvited {
					return httpx.BadRequest("Invited users become active after accepting their invite")
				}
			case auth.StatusDisabled:
			default:
				return httpx.BadRequest("Invalid status", httpx.Field("status", "Use active or disabled"))
			}
			if *in.Status != u.Status {
				status = *in.Status
				meta["status"] = map[string]string{"from": u.Status, "to": status}
			}
		}
		if len(meta) > 0 {
			u, err = auth.ScanUser(tx.QueryRow(ctx, `
				UPDATE users u SET name = $2, system_role = $3, status = $4, updated_at = now()
				WHERE u.id = $1 RETURNING `+auth.UserColumns, u.ID, name, role, status))
			if err != nil {
				return err
			}
			if err := audit.Record(ctx, tx, actor, audit.ActionUserUpdate, "user", u.ID.String(), nil, meta); err != nil {
				return err
			}
		}
		if u.Status == auth.StatusDisabled {
			// Idempotent: also covers PATCH status=disabled on an already disabled user.
			if err := auth.RevokeUserTokens(ctx, tx, u.ID); err != nil {
				return err
			}
			if err := auth.DeleteUserSessions(ctx, tx, u.ID, nil); err != nil {
				return err
			}
			if err := auth.InvalidateInvites(ctx, tx, u.ID); err != nil {
				return err
			}
		}
		out = u.DTO()
		return nil
	})
	return out, err
}

// RegenerateInvite issues a new invite (invited users) or reset-password link
// (active users), invalidating older links. Disabled users are rejected.
func (s *Service) RegenerateInvite(ctx context.Context, actor *auth.Actor, id string) (UserInvite, error) {
	if err := requireAdmin(actor); err != nil {
		return UserInvite{}, err
	}
	userID, err := uuid.Parse(id)
	if err != nil {
		return UserInvite{}, errUserNotFound()
	}
	var out UserInvite
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		u, err := auth.ScanUser(tx.QueryRow(ctx, `SELECT `+auth.UserColumns+` FROM users u WHERE u.id = $1 FOR UPDATE`, userID))
		if db.IsNoRows(err) {
			return errUserNotFound()
		}
		if err != nil {
			return err
		}
		if u.Status == auth.StatusDisabled {
			return httpx.BadRequest("User is disabled")
		}
		kind := auth.InviteKindReset
		if u.Status == auth.StatusInvited {
			kind = auth.InviteKindInvite
		}
		adminID := actor.User.ID
		token, expires, err := auth.CreateInvite(ctx, tx, u.ID, kind, &adminID)
		if err != nil {
			return err
		}
		if err := audit.Record(ctx, tx, actor, audit.ActionUserInviteLink, "user", u.ID.String(), nil, audit.Meta{"kind": kind}); err != nil {
			return err
		}
		out = UserInvite{User: u.DTO(), InviteURL: s.auth.InviteURL(token), ExpiresAt: expires}
		return nil
	})
	return out, err
}

// RevokeSessions signs a user out everywhere (docs/08; not in the mock).
func (s *Service) RevokeSessions(ctx context.Context, actor *auth.Actor, id string) error {
	if err := requireAdmin(actor); err != nil {
		return err
	}
	userID, err := uuid.Parse(id)
	if err != nil {
		return errUserNotFound()
	}
	return db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, userID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return errUserNotFound()
		}
		if err := auth.DeleteUserSessions(ctx, tx, userID, nil); err != nil {
			return err
		}
		return audit.Record(ctx, tx, actor, audit.ActionUserUpdate, "user", userID.String(), nil, audit.Meta{"sessions": "revoked"})
	})
}
