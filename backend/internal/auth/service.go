// Package auth implements authentication: argon2id passwords, cookie
// sessions, login rate limiting, invites / reset links, Google OIDC sign-in and
// API tokens. It puts an *Actor in the request context (Authenticate) that
// every other package reads with ActorFrom / MustActor.
package auth

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
)

// Session / invite / rate-limit policy (docs/13).
const (
	SessionCookie      = "qatlas_session"
	SessionIdleTTL     = 7 * 24 * time.Hour
	SessionMaxTTL      = 30 * 24 * time.Hour
	sessionTouchEvery  = time.Minute
	InviteTTL          = 72 * time.Hour
	LoginWindow        = 15 * time.Minute
	LoginMaxFailures   = 10 // per email + IP within LoginWindow
	LoginMaxIPFailures = 50 // per IP (any email) within LoginWindow
	tokenTouchEvery    = time.Minute
)

// Service holds auth dependencies. Construct with New.
type Service struct {
	pool       *pgxpool.Pool
	cfg        *config.Config
	log        *slog.Logger
	googleCfg  *googleSettings // active Google sign-in configuration (env or Admin → Google sign-in)
	googleOIDC *googleProvider // lazy OIDC discovery, shared by every configuration
}

// New builds the auth service. Google sign-in settings are read lazily (no
// database or network access here); wire ReloadGoogleSettings to NOTIFY
// qatlas_settings 'google_auth' for changes made by other processes.
func New(pool *pgxpool.Pool, cfg *config.Config, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	s := &Service{pool: pool, cfg: cfg, log: logger, googleCfg: newGoogleSettings(pool, cfg), googleOIDC: &googleProvider{issuer: googleIssuer}}
	if cfg.GoogleClientID == "" && len(cfg.GoogleAllowedDomains) > 0 {
		logger.Warn("GOOGLE_ALLOWED_DOMAINS is ignored without GOOGLE_CLIENT_ID; set the allowed domains in Admin → Google sign-in")
	}
	return s
}

// MeProject is one entry of Me.projects.
type MeProject struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Role string `json:"role"`
}

// Me is the OpenAPI Me schema.
type Me struct {
	User     UserDTO     `json:"user"`
	Projects []MeProject `json:"projects"`
}

// LoadMe builds Me for u: every non-archived project with the user's effective
// role (membership role, or maintainer for admins without membership).
func LoadMe(ctx context.Context, q db.Querier, u User) (Me, error) {
	rows, err := q.Query(ctx, `
		SELECT p.key, p.name, COALESCE(pm.role, 'maintainer')
		FROM projects p
		LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
		WHERE p.archived_at IS NULL AND (pm.user_id IS NOT NULL OR $2)
		ORDER BY p.created_at, p.key`, u.ID, u.IsAdmin())
	if err != nil {
		return Me{}, err
	}
	defer rows.Close()
	projects := []MeProject{}
	for rows.Next() {
		var p MeProject
		if err := rows.Scan(&p.Key, &p.Name, &p.Role); err != nil {
			return Me{}, err
		}
		projects = append(projects, p)
	}
	if err := rows.Err(); err != nil {
		return Me{}, err
	}
	return Me{User: u.DTO(), Projects: projects}, nil
}

// LoadUser fetches a user by id (pgx.ErrNoRows when missing).
func LoadUser(ctx context.Context, q db.Querier, id any) (User, error) {
	return ScanUser(q.QueryRow(ctx, `SELECT `+UserColumns+` FROM users u WHERE u.id = $1`, id))
}

func seconds(d time.Duration) int64 { return int64(d / time.Second) }
