package auth

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// System roles, user statuses and token scopes.
const (
	SystemRoleAdmin  = "admin"
	SystemRoleMember = "member"

	StatusInvited  = "invited"
	StatusActive   = "active"
	StatusDisabled = "disabled"

	ScopeRead  = "read"
	ScopeWrite = "write"
	ScopeRun   = "run"
)

// AllScopes lists valid API token scopes in canonical order.
var AllScopes = []string{ScopeRead, ScopeWrite, ScopeRun}

// User is a users row.
type User struct {
	ID           uuid.UUID
	Email        string
	Name         string
	PasswordHash *string
	GoogleSub    *string
	SystemRole   string
	Status       string
	Locale       string
	LastLoginAt  *time.Time
	CreatedAt    time.Time
}

// UserColumns selects a User from a table aliased "u"; scan with ScanUser.
const UserColumns = `u.id, u.email, u.name, u.password_hash, u.google_sub, u.system_role, u.status, u.locale, u.last_login_at, u.created_at`

// ScanUser scans UserColumns (optionally followed by extra destinations).
func ScanUser(row pgx.Row, extra ...any) (User, error) {
	var u User
	dest := append([]any{&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.GoogleSub, &u.SystemRole, &u.Status, &u.Locale, &u.LastLoginAt, &u.CreatedAt}, extra...)
	err := row.Scan(dest...)
	return u, err
}

// IsAdmin reports system role admin.
func (u User) IsAdmin() bool { return u.SystemRole == SystemRoleAdmin }

// UserDTO is the OpenAPI User schema.
type UserDTO struct {
	ID           uuid.UUID  `json:"id"`
	Email        string     `json:"email"`
	Name         string     `json:"name"`
	SystemRole   string     `json:"system_role"`
	Status       string     `json:"status"`
	Locale       string     `json:"locale"`
	HasPassword  bool       `json:"has_password"`
	GoogleLinked bool       `json:"google_linked"`
	LastLoginAt  *time.Time `json:"last_login_at"`
	CreatedAt    time.Time  `json:"created_at"`
}

// DTO converts to the API shape.
func (u User) DTO() UserDTO {
	return UserDTO{
		ID:           u.ID,
		Email:        u.Email,
		Name:         u.Name,
		SystemRole:   u.SystemRole,
		Status:       u.Status,
		Locale:       u.Locale,
		HasPassword:  u.PasswordHash != nil,
		GoogleLinked: u.GoogleSub != nil,
		LastLoginAt:  UTCPtr(u.LastLoginAt),
		CreatedAt:    u.CreatedAt.UTC(),
	}
}

// UserRef is the OpenAPI UserRef schema ({id, name, email}).
type UserRef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// NewUserRef builds a UserRef from nullable joined columns (LEFT JOIN users);
// a missing user renders like the mock's "deleted user" placeholder.
func NewUserRef(id *uuid.UUID, name, email *string) UserRef {
	if id == nil {
		return UserRef{ID: "unknown", Name: "Deleted user", Email: ""}
	}
	ref := UserRef{ID: id.String(), Name: "Deleted user"}
	if name != nil {
		ref.Name = *name
	}
	if email != nil {
		ref.Email = *email
	}
	return ref
}

// UTCPtr normalises an optional timestamp to UTC for JSON output.
func UTCPtr(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}

// Actor is the authenticated principal of a request (session or API token).
type Actor struct {
	User      User
	SessionID *uuid.UUID // set for cookie sessions
	TokenID   *uuid.UUID // set for API tokens
	// Scopes of the API token; nil for sessions (= every scope).
	Scopes []string
	// ProjectIDs restricts an API token to these projects; nil = unrestricted.
	ProjectIDs []uuid.UUID
}

// AuditIdentity implements audit.Principal (nil-safe).
func (a *Actor) AuditIdentity() (userID, tokenID *uuid.UUID) {
	if a == nil {
		return nil, nil
	}
	id := a.User.ID
	return &id, a.TokenID
}

// ViaToken reports whether the request was authenticated by an API token.
func (a *Actor) ViaToken() bool { return a != nil && a.TokenID != nil }

// IsAdmin reports system role admin.
func (a *Actor) IsAdmin() bool { return a != nil && a.User.IsAdmin() }

// HasScope reports whether the actor may act with scope. Sessions have every scope.
func (a *Actor) HasScope(scope string) bool {
	if a == nil {
		return false
	}
	if a.TokenID == nil {
		return true
	}
	return slices.Contains(a.Scopes, scope)
}

// RequireScope returns 403 when an API token lacks scope.
func (a *Actor) RequireScope(scope string) error {
	if !a.HasScope(scope) {
		return httpx.Forbidden("API token is missing the '" + scope + "' scope")
	}
	return nil
}

// CanAccessProject applies the token's project restriction (role checks are
// authz's job). Sessions and unrestricted tokens always pass.
func (a *Actor) CanAccessProject(projectID uuid.UUID) bool {
	if a == nil {
		return false
	}
	return a.ProjectIDs == nil || slices.Contains(a.ProjectIDs, projectID)
}

type actorKey struct{}

// WithActor stores the actor in ctx (used by middleware, MCP and tests).
func WithActor(ctx context.Context, a *Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFrom returns the request's actor or nil when anonymous.
func ActorFrom(ctx context.Context) *Actor {
	a, _ := ctx.Value(actorKey{}).(*Actor)
	return a
}

// MustActor returns the actor or a 401 error.
func MustActor(ctx context.Context) (*Actor, error) {
	if a := ActorFrom(ctx); a != nil {
		return a, nil
	}
	return nil, ErrUnauthenticated()
}

// ErrUnauthenticated is the 401 returned when no valid session/token is present.
func ErrUnauthenticated() *httpx.APIError {
	return httpx.Unauthenticated("Your session has expired, please sign in again")
}

// RequireAuth rejects anonymous requests with 401. Mount it on every group
// that needs a signed-in user (after Service.Authenticate).
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ActorFrom(r.Context()) == nil {
			httpx.WriteError(w, r, ErrUnauthenticated())
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireSession rejects API-token requests with 403 (admin endpoints and
// token management are browser-session only, so a token can never mint or
// widen tokens).
func RequireSession(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if a := ActorFrom(r.Context()); a != nil && a.ViaToken() {
			httpx.WriteError(w, r, httpx.Forbidden("This endpoint requires a signed-in session, not an API token"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireMethodScope enforces the default token scope by HTTP method: read for
// GET/HEAD, write for everything else. Use it on non-project groups (/me,
// /admin). Project-scoped endpoints rely on authz.ProjectAccess instead, which
// maps each action to its scope (e.g. run → "run").
func RequireMethodScope(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scope := ScopeWrite
		if httpx.IsSafeMethod(r.Method) {
			scope = ScopeRead
		}
		if err := ActorFrom(r.Context()).RequireScope(scope); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireScope enforces a specific scope on a route:
//
//	r.With(auth.RequireScope(auth.ScopeRun)).Post("/runs/{runKey}/cancel", ...)
func RequireScope(scope string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if err := ActorFrom(r.Context()).RequireScope(scope); err != nil {
				httpx.WriteError(w, r, err)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
