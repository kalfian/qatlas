package users

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts /me/* and /admin/users/*. Mount inside the authenticated
// group (auth.RequireAuth already applied).
func (s *Service) Routes(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireMethodScope)
		r.Get("/me", httpx.Handle(s.handleGetMe))
		r.Patch("/me", httpx.Handle(s.handleUpdateMe))
		r.Get("/me/tokens", httpx.Handle(s.handleListTokens))
		r.Get("/me/manual-runs", httpx.Handle(s.handleManualRuns))
	})
	// Token management and user administration are session-only: an API
	// token must never be able to mint tokens or manage accounts.
	r.Group(func(r chi.Router) {
		r.Use(auth.RequireSession)
		r.Post("/me/tokens", httpx.Handle(s.handleCreateToken))
		r.Delete("/me/tokens/{id}", httpx.Handle(s.handleRevokeToken))
		r.Get("/admin/users", httpx.Handle(s.handleListUsers))
		r.Post("/admin/users", httpx.Handle(s.handleCreateUser))
		r.Patch("/admin/users/{id}", httpx.Handle(s.handleUpdateUser))
		r.Post("/admin/users/{id}/invite-link", httpx.Handle(s.handleInviteLink))
		r.Post("/admin/users/{id}/revoke-sessions", httpx.Handle(s.handleRevokeSessions))
	})
}

func (s *Service) handleGetMe(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	me, err := s.Me(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, me)
}

func (s *Service) handleUpdateMe(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in UpdateMeInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	me, err := s.UpdateMe(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.OK(w, me)
}

func (s *Service) handleListTokens(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.auth.ListTokens(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleCreateToken(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in auth.CreateTokenInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	created, err := s.auth.CreateToken(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.Created(w, created)
}

func (s *Service) handleRevokeToken(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.auth.RevokeToken(r.Context(), actor, chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

func (s *Service) handleManualRuns(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.ManualRuns(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleListUsers(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.ListUsers(r.Context(), actor)
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleCreateUser(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in CreateUserInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.CreateUser(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.Created(w, out)
}

func (s *Service) handleUpdateUser(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in AdminUpdateUserInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.UpdateUser(r.Context(), actor, chi.URLParam(r, "id"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleInviteLink(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.RegenerateInvite(r.Context(), actor, chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleRevokeSessions(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.RevokeSessions(r.Context(), actor, chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}
