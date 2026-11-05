package auth

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts the public /auth/* endpoints. Mount on the /api/v1 router
// after Authenticate (no RequireAuth: these work anonymously).
func (s *Service) Routes(r chi.Router) {
	r.Get("/auth/config", httpx.Handle(s.handleConfig))
	r.Post("/auth/login", httpx.Handle(s.handleLogin))
	r.Post("/auth/logout", httpx.Handle(s.handleLogout))
	r.Get("/auth/google/start", s.GoogleStart)
	r.Get("/auth/google/callback", s.GoogleCallback)
	r.Get("/auth/invites/{token}", httpx.Handle(s.handleGetInvite))
	r.Post("/auth/invites/{token}/accept", httpx.Handle(s.handleAcceptInvite))
}

// AuthConfig is the public login configuration.
type AuthConfig struct {
	GoogleEnabled bool   `json:"google_enabled"`
	Mode          string `json:"mode"`
}

func (s *Service) handleConfig(w http.ResponseWriter, r *http.Request) error {
	return httpx.OK(w, AuthConfig{GoogleEnabled: s.GoogleEnabled(r.Context()), Mode: "real"})
}

func (s *Service) handleLogin(w http.ResponseWriter, r *http.Request) error {
	var in LoginInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	me, err := s.Login(r.Context(), w, r, in)
	if err != nil {
		return err
	}
	return httpx.OK(w, me)
}

func (s *Service) handleLogout(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	if a := ActorFrom(ctx); a != nil && !a.ViaToken() {
		if err := audit.Record(ctx, s.pool, a, audit.ActionLogout, "user", a.User.ID.String(), nil, nil); err != nil {
			return err
		}
	}
	if err := s.Logout(ctx, w, r); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

func (s *Service) handleGetInvite(w http.ResponseWriter, r *http.Request) error {
	info, err := s.GetInvite(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		return err
	}
	return httpx.OK(w, info)
}

func (s *Service) handleAcceptInvite(w http.ResponseWriter, r *http.Request) error {
	var in AcceptInviteInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	me, err := s.AcceptInvite(r.Context(), w, r, chi.URLParam(r, "token"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, me)
}
