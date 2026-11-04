package projects

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts the project endpoints. Mount inside the authenticated group.
// Paths are registered flat (no r.Route) so other packages can add
// /projects/{key}/… routes to the same router.
func (s *Service) Routes(r chi.Router) {
	// Not project-scoped: default token scope by method.
	r.With(auth.RequireMethodScope).Get("/projects", httpx.Handle(s.handleList))
	r.With(auth.RequireMethodScope).Post("/projects", httpx.Handle(s.handleCreate))

	// Project-scoped: authz.ProjectAccess checks role + token scope.
	r.Get("/projects/{key}", httpx.Handle(s.handleGet))
	r.Patch("/projects/{key}", httpx.Handle(s.handleUpdate))
	r.Post("/projects/{key}/archive", httpx.Handle(s.handleArchive))
	r.Get("/projects/{key}/stats", httpx.Handle(s.handleStats))
	r.Get("/projects/{key}/members", httpx.Handle(s.handleMembers))
	r.Post("/projects/{key}/members", httpx.Handle(s.handleAddMember))
	r.Patch("/projects/{key}/members/{userId}", httpx.Handle(s.handleUpdateMember))
	r.Delete("/projects/{key}/members/{userId}", httpx.Handle(s.handleRemoveMember))
	r.Get("/projects/{key}/assignable-users", httpx.Handle(s.handleAssignable))
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.List(r.Context(), actor, r.URL.Query().Get("include_archived") == "true")
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
	var in CreateInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Create(r.Context(), actor, in)
	if err != nil {
		return err
	}
	return httpx.Created(w, out)
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.Get(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
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
	out, err := s.Update(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleArchive(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.Archive(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleStats(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	out, err := s.Stats(r.Context(), actor, chi.URLParam(r, "key"), r.URL.Query().Get("range"))
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleMembers(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.Members(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleAddMember(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in AddMemberInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.AddMember(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.Created(w, out)
}

func (s *Service) handleUpdateMember(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in UpdateMemberInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.UpdateMember(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "userId"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleRemoveMember(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.RemoveMember(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "userId")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

func (s *Service) handleAssignable(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.AssignableUsers(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}
