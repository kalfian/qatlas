package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// createSession inserts a session and returns the raw cookie token.
func createSession(ctx context.Context, q db.Querier, userID uuid.UUID, r *http.Request) (string, time.Time, error) {
	token := randomToken(32)
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	var expires time.Time
	err := q.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at)
		VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 second')
		RETURNING expires_at`,
		db.NewID(), userID, hashToken(token), ua, httpx.ClientIPFrom(ctx), seconds(SessionIdleTTL)).Scan(&expires)
	return token, expires, err
}

func (s *Service) setSessionCookie(w http.ResponseWriter, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   max(1, int(time.Until(expires).Seconds())),
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
}

func (s *Service) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
}

// startSession creates a session for u and sets the cookie.
func (s *Service) startSession(ctx context.Context, q db.Querier, w http.ResponseWriter, r *http.Request, userID uuid.UUID) error {
	token, expires, err := createSession(ctx, q, userID, r)
	if err != nil {
		return err
	}
	s.setSessionCookie(w, token, expires)
	return nil
}

// DeleteUserSessions removes every session of a user except keep (may be nil).
func DeleteUserSessions(ctx context.Context, q db.Querier, userID uuid.UUID, keep *uuid.UUID) error {
	_, err := q.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)`, userID, keep)
	return err
}

// Authenticate resolves the request's actor and stores it in the context.
//
//   - Authorization: Bearer qat_… → API token; an invalid token is a 401 (no
//     fallback to the cookie).
//   - otherwise cookie qatlas_session → session with sliding expiry.
//   - otherwise anonymous (RequireAuth rejects where needed).
func (s *Service) Authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if h := r.Header.Get("Authorization"); h != "" {
			if !httpx.HasBearer(r) {
				httpx.WriteError(w, r, httpx.Unauthenticated("Unsupported Authorization header, use Bearer"))
				return
			}
			actor, err := s.authenticateToken(ctx, strings.TrimSpace(h[7:]))
			if err != nil {
				httpx.WriteError(w, r, err)
				return
			}
			next.ServeHTTP(w, r.WithContext(WithActor(ctx, actor)))
			return
		}
		if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
			actor, err := s.authenticateSession(ctx, w, c.Value)
			if err != nil {
				httpx.WriteError(w, r, err)
				return
			}
			if actor != nil {
				ctx = WithActor(ctx, actor)
			}
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// authenticateSession returns (nil, nil) for unknown/expired sessions.
func (s *Service) authenticateSession(ctx context.Context, w http.ResponseWriter, token string) (*Actor, error) {
	var (
		sessionID     uuid.UUID
		expired, idle bool
	)
	u, err := ScanUser(s.pool.QueryRow(ctx, `
		SELECT `+UserColumns+`, s.id, s.expires_at <= now(), s.last_seen_at < now() - $2 * interval '1 second'
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1`, hashToken(token), seconds(sessionTouchEvery)),
		&sessionID, &expired, &idle)
	if db.IsNoRows(err) {
		s.clearSessionCookie(w)
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if expired || u.Status != StatusActive {
		if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, sessionID); err != nil {
			return nil, err
		}
		s.clearSessionCookie(w)
		return nil, nil
	}
	if idle {
		// Slide: 7 days from now, capped at 30 days after creation.
		var expires time.Time
		err := s.pool.QueryRow(ctx, `
			UPDATE sessions SET last_seen_at = now(),
				expires_at = LEAST(now() + $2 * interval '1 second', created_at + $3 * interval '1 second')
			WHERE id = $1 RETURNING expires_at`,
			sessionID, seconds(SessionIdleTTL), seconds(SessionMaxTTL)).Scan(&expires)
		if err != nil && !db.IsNoRows(err) {
			return nil, err
		}
		if err == nil {
			s.setSessionCookie(w, token, expires)
		}
	}
	return &Actor{User: u, SessionID: &sessionID}, nil
}

// Logout deletes the current session (if any) and clears the cookie.
func (s *Service) Logout(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, hashToken(c.Value)); err != nil {
			return err
		}
	}
	s.clearSessionCookie(w)
	return nil
}
