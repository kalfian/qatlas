package auth

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/oauth2"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

const (
	googleIssuer     = "https://accounts.google.com"
	oidcStateCookie  = "qatlas_oidc"
	oidcCookiePath   = "/api/v1/auth/google"
	oidcStateTTL     = 10 * time.Minute
	loginErrRedirect = "/login?error="
)

// Redirect error codes understood by the web login page.
const (
	googleErrNotRegistered = "not_registered"
	googleErrFailed        = "google_failed"
)

// googleAuth lazily discovers Google's OIDC configuration on first use, so
// the server starts even when Google is unreachable.
type googleAuth struct {
	cfg *config.Config

	mu       sync.Mutex
	provider *oidc.Provider
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func newGoogleAuth(cfg *config.Config) *googleAuth { return &googleAuth{cfg: cfg} }

func (g *googleAuth) init(ctx context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.provider != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, googleIssuer)
	if err != nil {
		return err
	}
	g.provider = p
	g.oauth = &oauth2.Config{
		ClientID:     g.cfg.GoogleClientID,
		ClientSecret: g.cfg.GoogleClientSecret,
		Endpoint:     p.Endpoint(),
		RedirectURL:  g.cfg.BaseURL + "/api/v1/auth/google/callback",
		Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
	}
	g.verifier = p.Verifier(&oidc.Config{ClientID: g.cfg.GoogleClientID})
	return nil
}

type oidcState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
}

// GoogleEnabled reports whether Google sign-in is configured.
func (s *Service) GoogleEnabled() bool { return s.google != nil }

// GoogleStart redirects to Google (authorization code + PKCE, state, nonce).
func (s *Service) GoogleStart(w http.ResponseWriter, r *http.Request) {
	if s.google == nil {
		http.Redirect(w, r, loginErrRedirect+googleErrFailed, http.StatusFound)
		return
	}
	if err := s.google.init(r.Context()); err != nil {
		s.log.ErrorContext(r.Context(), "google oidc discovery failed", "err", err)
		http.Redirect(w, r, loginErrRedirect+googleErrFailed, http.StatusFound)
		return
	}
	st := oidcState{State: randomToken(24), Nonce: randomToken(24), Verifier: oauth2.GenerateVerifier()}
	raw, _ := json.Marshal(st)
	http.SetCookie(w, &http.Cookie{
		Name:     oidcStateCookie,
		Value:    base64.RawURLEncoding.EncodeToString(raw),
		Path:     oidcCookiePath,
		MaxAge:   int(oidcStateTTL.Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.SecureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
	url := s.google.oauth.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier),
		oauth2.SetAuthURLParam("prompt", "select_account"))
	http.Redirect(w, r, url, http.StatusFound)
}

// GoogleCallback finishes the flow and redirects to "/" or /login?error=….
func (s *Service) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fail := func(code, reason string, err error) {
		s.log.WarnContext(ctx, "google sign-in rejected", "reason", reason, "err", err)
		http.Redirect(w, r, loginErrRedirect+code, http.StatusFound)
	}
	if s.google == nil {
		fail(googleErrFailed, "disabled", nil)
		return
	}
	st, err := readOIDCState(r)
	http.SetCookie(w, &http.Cookie{Name: oidcStateCookie, Value: "", Path: oidcCookiePath, MaxAge: -1, HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode})
	if err != nil {
		fail(googleErrFailed, "missing state cookie", err)
		return
	}
	q := r.URL.Query()
	if e := q.Get("error"); e != "" {
		fail(googleErrFailed, "provider error "+e, nil)
		return
	}
	if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(st.State)) != 1 {
		fail(googleErrFailed, "state mismatch", nil)
		return
	}
	if err := s.google.init(ctx); err != nil {
		fail(googleErrFailed, "discovery", err)
		return
	}
	tok, err := s.google.oauth.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(st.Verifier))
	if err != nil {
		fail(googleErrFailed, "code exchange", err)
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		fail(googleErrFailed, "no id_token", nil)
		return
	}
	idt, err := s.google.verifier.Verify(ctx, rawID)
	if err != nil {
		fail(googleErrFailed, "id_token verify", err)
		return
	}
	if subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(st.Nonce)) != 1 {
		fail(googleErrFailed, "nonce mismatch", nil)
		return
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified any    `json:"email_verified"`
	}
	if err := idt.Claims(&claims); err != nil {
		fail(googleErrFailed, "claims", err)
		return
	}
	verified := claims.EmailVerified == true || claims.EmailVerified == "true"
	redirect := s.CompleteGoogleLogin(ctx, w, r, GoogleIdentity{Subject: idt.Subject, Email: claims.Email, EmailVerified: verified})
	http.Redirect(w, r, redirect, http.StatusFound)
}

func readOIDCState(r *http.Request) (oidcState, error) {
	var st oidcState
	c, err := r.Cookie(oidcStateCookie)
	if err != nil {
		return st, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return st, err
	}
	if st.State == "" || st.Nonce == "" || st.Verifier == "" {
		return st, errors.New("incomplete state")
	}
	return st, nil
}

// GoogleIdentity is the verified subset of the Google ID token.
type GoogleIdentity struct {
	Subject       string
	Email         string
	EmailVerified bool
}

var errNotRegistered = errors.New("not registered")

// CompleteGoogleLogin applies the docs/05 rules to a verified identity and,
// when accepted, creates a session. It returns the redirect target:
//
//  1. email_verified must be true;
//  2. GOOGLE_ALLOWED_DOMAINS (if set) must contain the email domain;
//  3. the email must belong to an invited/active user (no user is created);
//  4. an existing google_sub binding must match.
//
// First sign-in stores google_sub and turns invited → active.
func (s *Service) CompleteGoogleLogin(ctx context.Context, w http.ResponseWriter, r *http.Request, id GoogleIdentity) string {
	email := strings.ToLower(strings.TrimSpace(id.Email))
	ip := httpx.ClientIPFrom(ctx)
	reject := func(reason string, userID *uuid.UUID) string {
		var who audit.Principal
		entity := ""
		if userID != nil {
			who = audit.User(*userID)
			entity = userID.String()
		}
		if err := audit.Record(ctx, s.pool, who, audit.ActionLoginFailed, "user", entity, nil,
			audit.Meta{"method": "google", "email": email, "ip": ip, "reason": reason}); err != nil {
			s.log.ErrorContext(ctx, "audit google login failure", "err", err)
		}
		s.log.WarnContext(ctx, "google sign-in rejected", "reason", reason, "email", email)
		return loginErrRedirect + googleErrNotRegistered
	}

	if !id.EmailVerified || email == "" || id.Subject == "" {
		return reject("email_not_verified", nil)
	}
	if len(s.cfg.GoogleAllowedDomains) > 0 {
		at := strings.LastIndexByte(email, '@')
		if at < 0 || !slices.Contains(s.cfg.GoogleAllowedDomains, email[at+1:]) {
			return reject("domain_not_allowed", nil)
		}
	}

	var rejectReason string
	var rejectUser *uuid.UUID
	err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
		u, err := ScanUser(tx.QueryRow(ctx, `SELECT `+UserColumns+` FROM users u WHERE u.email = $1 FOR UPDATE`, email))
		if db.IsNoRows(err) {
			rejectReason = "unknown_email"
			return errNotRegistered
		}
		if err != nil {
			return err
		}
		if u.Status == StatusDisabled {
			rejectReason, rejectUser = "user_disabled", &u.ID
			return errNotRegistered
		}
		if u.GoogleSub != nil && *u.GoogleSub != id.Subject {
			rejectReason, rejectUser = "google_sub_mismatch", &u.ID
			return errNotRegistered
		}
		uid := u.ID
		u, err = ScanUser(tx.QueryRow(ctx, `
			UPDATE users u SET google_sub = $2, status = 'active', last_login_at = now(), updated_at = now()
			WHERE u.id = $1 RETURNING `+UserColumns, uid, id.Subject))
		if db.IsUniqueViolation(err, "users_google_sub_key") {
			rejectReason, rejectUser = "google_sub_bound_to_other_user", &uid
			return errNotRegistered
		}
		if err != nil {
			return err
		}
		if err := InvalidateInvites(ctx, tx, u.ID); err != nil {
			return err
		}
		if err := s.startSession(ctx, tx, w, r, u.ID); err != nil {
			return err
		}
		return audit.Record(ctx, tx, &Actor{User: u}, audit.ActionLogin, "user", u.ID.String(), nil, audit.Meta{"method": "google", "ip": ip})
	})
	if errors.Is(err, errNotRegistered) {
		return reject(rejectReason, rejectUser)
	}
	if err != nil {
		s.log.ErrorContext(ctx, "google sign-in failed", "err", err)
		return loginErrRedirect + googleErrFailed
	}
	return "/"
}
