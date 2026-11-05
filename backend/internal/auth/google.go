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
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

const (
	googleIssuer       = "https://accounts.google.com"
	googleAuthURL      = "https://accounts.google.com/o/oauth2/v2/auth" // = discovery's authorization_endpoint
	googleTokenURL     = "https://oauth2.googleapis.com/token"
	GoogleCallbackPath = "/api/v1/auth/google/callback"
	oidcStateCookie    = "qatlas_oidc"
	oidcCookiePath     = "/api/v1/auth/google"
	oidcStateTTL       = 10 * time.Minute
	loginErrRedirect   = "/login?error="
)

// Redirect error codes understood by the web login page.
const (
	googleErrNotRegistered    = "not_registered"
	googleErrFailed           = "google_failed"
	googleErrDomainNotAllowed = "domain_not_allowed"
)

var googleScopes = []string{oidc.ScopeOpenID, "email", "profile"}

// googleProvider discovers Google's OIDC configuration (token endpoint, JWKS)
// lazily, on the first callback: start redirects to the fixed authorization
// endpoint, so neither the server start nor /auth/google/start needs Google.
// A failed discovery is not cached (the next callback retries).
type googleProvider struct {
	issuer string
	mu     sync.Mutex
	p      *oidc.Provider
}

func (g *googleProvider) get(ctx context.Context) (*oidc.Provider, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.p != nil {
		return g.p, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, g.issuer)
	if err != nil {
		return nil, err
	}
	g.p = p
	return p, nil
}

// googleRedirectURL is the OAuth redirect URI of this installation.
func (s *Service) googleRedirectURL() string { return s.cfg.BaseURL + GoogleCallbackPath }

func (s *Service) googleOAuth(c *googleClient, endpoint oauth2.Endpoint) *oauth2.Config {
	return &oauth2.Config{
		ClientID:     c.clientID,
		ClientSecret: c.clientSecret,
		Endpoint:     endpoint,
		RedirectURL:  s.googleRedirectURL(),
		Scopes:       googleScopes,
	}
}

type oidcState struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
}

// GoogleEnabled reports whether Google sign-in is active right now (env
// configuration, or enabled settings from Admin → Google sign-in).
func (s *Service) GoogleEnabled(ctx context.Context) bool {
	c, err := s.googleCfg.active(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "load google sign-in settings", "err", err)
		return false
	}
	return c.enabled
}

// GoogleStart redirects to Google (authorization code + PKCE, state, nonce).
func (s *Service) GoogleStart(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := s.googleCfg.active(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "load google sign-in settings", "err", err)
	}
	if err != nil || !c.enabled {
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
	oc := s.googleOAuth(c, oauth2.Endpoint{AuthURL: googleAuthURL, TokenURL: googleTokenURL})
	url := oc.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier),
		oauth2.SetAuthURLParam("prompt", "select_account"))
	http.Redirect(w, r, url, http.StatusFound)
}

// GoogleCallback finishes the flow and redirects to "/" or /login?error=….
// The client credentials are the ones active now (a change between start and
// callback applies immediately).
func (s *Service) GoogleCallback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fail := func(code, reason string, err error) {
		s.log.WarnContext(ctx, "google sign-in rejected", "reason", reason, "err", err)
		http.Redirect(w, r, loginErrRedirect+code, http.StatusFound)
	}
	c, err := s.googleCfg.active(ctx)
	if err != nil {
		fail(googleErrFailed, "settings", err)
		return
	}
	if !c.enabled {
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
	provider, err := s.googleOIDC.get(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "google oidc discovery failed", "err", err)
		fail(googleErrFailed, "discovery", err)
		return
	}
	tok, err := s.googleOAuth(c, provider.Endpoint()).Exchange(ctx, q.Get("code"), oauth2.VerifierOption(st.Verifier))
	if err != nil {
		fail(googleErrFailed, "code exchange", err)
		return
	}
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		fail(googleErrFailed, "no id_token", nil)
		return
	}
	idt, err := provider.Verifier(&oidc.Config{ClientID: c.clientID}).Verify(ctx, rawID)
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
//  2. the allowed domains of the active configuration (if any) must contain
//     the email domain;
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
		// Only the domain rule is reported specifically (it reveals no account state); every other
		// rejection stays the generic "not registered".
		if reason == googleErrDomainNotAllowed {
			return loginErrRedirect + googleErrDomainNotAllowed
		}
		return loginErrRedirect + googleErrNotRegistered
	}

	if !id.EmailVerified || email == "" || id.Subject == "" {
		return reject("email_not_verified", nil)
	}
	gc, err := s.googleCfg.active(ctx)
	if err != nil {
		s.log.ErrorContext(ctx, "load google sign-in settings", "err", err)
		return loginErrRedirect + googleErrFailed
	}
	if len(gc.allowedDomains) > 0 {
		at := strings.LastIndexByte(email, '@')
		if at < 0 || !slices.Contains(gc.allowedDomains, email[at+1:]) {
			return reject(googleErrDomainNotAllowed, nil)
		}
	}

	var rejectReason string
	var rejectUser *uuid.UUID
	err = db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
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
