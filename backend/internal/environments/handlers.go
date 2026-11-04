package environments

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts the environment endpoints (project-scoped; authz.ProjectAccess
// checks role + token scope). Mount inside the authenticated group.
func (s *Service) Routes(r chi.Router) {
	r.Get("/projects/{key}/environments", httpx.Handle(s.handleList))
	r.Post("/projects/{key}/environments", httpx.Handle(s.handleCreate))
	r.Patch("/projects/{key}/environments/{id}", httpx.Handle(s.handleUpdate))
	r.Delete("/projects/{key}/environments/{id}", httpx.Handle(s.handleDelete))
	r.Put("/projects/{key}/environments/{id}/secrets/{name}", httpx.Handle(s.handleSetSecret))
	r.Delete("/projects/{key}/environments/{id}/secrets/{name}", httpx.Handle(s.handleDeleteSecret))
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.List(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleCreate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in Input
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Create(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.Created(w, out)
}

func (s *Service) handleUpdate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in Input
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Update(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.Delete(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

// secretInput is the PUT …/secrets/{name} body. Never log it.
type secretInput struct {
	Value string `json:"value"`
}

func (s *Service) handleSetSecret(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in secretInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.SetSecret(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id"), chi.URLParam(r, "name"), in.Value)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleDeleteSecret(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.DeleteSecret(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id"), chi.URLParam(r, "name"))
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}
