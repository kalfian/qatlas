package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// LoginInput is the OpenAPI LoginRequest.
type LoginInput struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func errInvalidCredentials() *httpx.APIError {
	return httpx.NewError(http.StatusUnauthorized, httpx.CodeInvalidCredentials, "Invalid email or password.")
}

func errRateLimited() *httpx.APIError {
	return httpx.NewError(http.StatusTooManyRequests, httpx.CodeRateLimited,
		"Too many failed sign-in attempts. Try again in 15 minutes.")
}

// Login verifies email + password, enforces the rate limit, creates a session
// cookie and returns Me. Errors are generic so account existence never leaks.
func (s *Service) Login(ctx context.Context, w http.ResponseWriter, r *http.Request, in LoginInput) (Me, error) {
	email := strings.ToLower(strings.TrimSpace(in.Email))
	ip := httpx.ClientIPFrom(ctx)

	limited, err := s.loginLimited(ctx, email, ip)
	if err != nil {
		return Me{}, err
	}
	if limited {
		return Me{}, errRateLimited()
	}

	u, err := ScanUser(s.pool.QueryRow(ctx, `SELECT `+UserColumns+` FROM users u WHERE u.email = $1`, email))
	found := err == nil
	if err != nil && !db.IsNoRows(err) {
		return Me{}, err
	}

	ok := false
	if found && u.PasswordHash != nil {
		ok, err = VerifyPassword(in.Password, *u.PasswordHash)
		if err != nil {
			s.log.ErrorContext(ctx, "stored password hash is malformed", "user_id", u.ID)
			ok = false
		}
	} else {
		_, _ = VerifyPassword(in.Password, dummyHash()) // equalise timing
	}

	if !ok || u.Status != StatusActive {
		reason := "bad_password"
		switch {
		case !found:
			reason = "unknown_email"
		case u.PasswordHash == nil:
			reason = "no_password"
		case ok:
			reason = "status_" + u.Status
		}
		err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
			if err := recordAttempt(ctx, tx, email, ip, false); err != nil {
				return err
			}
			var who audit.Principal
			entityID := ""
			if found {
				who = audit.User(u.ID)
				entityID = u.ID.String()
			}
			return audit.Record(ctx, tx, who, audit.ActionLoginFailed, "user", entityID, nil,
				audit.Meta{"method": "password", "email": email, "ip": ip, "reason": reason})
		})
		if err != nil {
			return Me{}, err
		}
		return Me{}, errInvalidCredentials()
	}

	var me Me
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		if err := recordAttempt(ctx, tx, email, ip, true); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING last_login_at`, u.ID).Scan(&u.LastLoginAt); err != nil {
			return err
		}
		if err := s.startSession(ctx, tx, w, r, u.ID); err != nil {
			return err
		}
		actor := &Actor{User: u}
		if err := audit.Record(ctx, tx, actor, audit.ActionLogin, "user", u.ID.String(), nil, audit.Meta{"method": "password", "ip": ip}); err != nil {
			return err
		}
		me, err = LoadMe(ctx, tx, u)
		return err
	})
	return me, err
}

// loginLimited reports whether email+IP (or the IP alone) exceeded the
// failure budget in the window. Failures before the last success for the same
// email+IP do not count.
func (s *Service) loginLimited(ctx context.Context, email, ip string) (bool, error) {
	var pair, perIP int
	err := s.pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM login_attempts a
			  WHERE a.email = $1 AND a.ip = $2 AND NOT a.success
			    AND a.created_at > now() - $3 * interval '1 second'
			    AND a.created_at > COALESCE((SELECT max(b.created_at) FROM login_attempts b
			                                  WHERE b.email = $1 AND b.ip = $2 AND b.success), '-infinity')),
			(SELECT count(*) FROM login_attempts a
			  WHERE a.ip = $2 AND NOT a.success AND a.created_at > now() - $3 * interval '1 second')`,
		email, ip, seconds(LoginWindow)).Scan(&pair, &perIP)
	if err != nil {
		return false, err
	}
	return pair >= LoginMaxFailures || perIP >= LoginMaxIPFailures, nil
}

func recordAttempt(ctx context.Context, q db.Querier, email, ip string, success bool) error {
	if _, err := q.Exec(ctx, `INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)`, email, ip, success); err != nil {
		return err
	}
	// Opportunistic pruning keeps the table small without a background job.
	_, err := q.Exec(ctx, `DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`)
	return err
}
