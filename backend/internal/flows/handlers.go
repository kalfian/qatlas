package flows

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts the flow endpoints. Mount inside the authenticated group;
// authorisation is done by authz.ProjectAccess.
func (s *Service) Routes(r chi.Router) {
	r.Get("/projects/{key}/flows", httpx.Handle(s.handleList))
	r.Post("/projects/{key}/flows", httpx.Handle(s.handleCreate))
	r.Get("/flows/{flowKey}", httpx.Handle(s.handleGet))
	r.Patch("/flows/{flowKey}", httpx.Handle(s.handleUpdate))
	r.Delete("/flows/{flowKey}", httpx.Handle(s.handleDelete))
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.List(r.Context(), actor, chi.URLParam(r, "key"), strings.TrimSpace(r.URL.Query().Get("q")))
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
	fl, err := s.Create(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.Created(w, fl)
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	fl, err := s.Get(r.Context(), actor, chi.URLParam(r, "flowKey"))
	if err != nil {
		return err
	}
	return httpx.OK(w, fl)
}

func (s *Service) handleUpdate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in UpdateInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	fl, err := s.Update(r.Context(), actor, chi.URLParam(r, "flowKey"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, fl)
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.Delete(r.Context(), actor, chi.URLParam(r, "flowKey")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}
