package testcases

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts folders, tags, test cases and revisions. Mount inside the
// authenticated group; authorisation is done by authz.ProjectAccess.
func (s *Service) Routes(r chi.Router) {
	r.Get("/projects/{key}/folders", httpx.Handle(s.handleListFolders))
	r.Post("/projects/{key}/folders", httpx.Handle(s.handleCreateFolder))
	r.Patch("/projects/{key}/folders/{id}", httpx.Handle(s.handleUpdateFolder))
	r.Delete("/projects/{key}/folders/{id}", httpx.Handle(s.handleDeleteFolder))

	r.Get("/projects/{key}/tags", httpx.Handle(s.handleTags))

	r.Get("/projects/{key}/test-cases", httpx.Handle(s.handleList))
	r.Post("/projects/{key}/test-cases", httpx.Handle(s.handleCreate))
	r.Post("/projects/{key}/test-cases/validate", httpx.Handle(s.handleValidate))
	r.Post("/projects/{key}/test-cases/bulk", httpx.Handle(s.handleBulk))

	r.Get("/test-cases/{caseKey}", httpx.Handle(s.handleGet))
	r.Patch("/test-cases/{caseKey}", httpx.Handle(s.handleUpdate))
	r.Delete("/test-cases/{caseKey}", httpx.Handle(s.handleDelete))
	r.Post("/test-cases/{caseKey}/duplicate", httpx.Handle(s.handleDuplicate))
	r.Get("/test-cases/{caseKey}/revisions", httpx.Handle(s.handleRevisions))
	r.Get("/test-cases/{caseKey}/revisions/{rev}", httpx.Handle(s.handleRevision))
}

func (s *Service) handleListFolders(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.ListFolders(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleCreateFolder(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in FolderInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	f, err := s.CreateFolder(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.Created(w, f)
}

func (s *Service) handleUpdateFolder(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in FolderPatch
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	f, err := s.UpdateFolder(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, f)
}

func (s *Service) handleDeleteFolder(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.DeleteFolder(r.Context(), actor, chi.URLParam(r, "key"), chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

func (s *Service) handleTags(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.Tags(r.Context(), actor, chi.URLParam(r, "key"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	page, err := httpx.ParsePage(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	f := ListFilter{
		Folder:        q.Get("folder"),
		Q:             q.Get("q"),
		Status:        q.Get("status"),
		Priority:      q.Get("priority"),
		Execution:     q.Get("execution"),
		LastRunStatus: q.Get("last_run_status"),
	}
	for _, t := range strings.Split(q.Get("tags"), ",") {
		if t != "" {
			f.Tags = append(f.Tags, t)
		}
	}
	out, err := s.List(r.Context(), actor, chi.URLParam(r, "key"), f, page)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleValidate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in Input
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Validate(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
}

func (s *Service) handleBulk(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in BulkInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	out, err := s.Bulk(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, out)
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
	tc, err := s.Create(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	return httpx.Created(w, tc)
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	tc, err := s.Get(r.Context(), actor, chi.URLParam(r, "caseKey"))
	if err != nil {
		return err
	}
	return httpx.OK(w, tc)
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
	tc, err := s.Update(r.Context(), actor, chi.URLParam(r, "caseKey"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, tc)
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if err := s.Delete(r.Context(), actor, chi.URLParam(r, "caseKey")); err != nil {
		return err
	}
	return httpx.NoContent(w)
}

func (s *Service) handleDuplicate(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	tc, err := s.Duplicate(r.Context(), actor, chi.URLParam(r, "caseKey"))
	if err != nil {
		return err
	}
	return httpx.Created(w, tc)
}

func (s *Service) handleRevisions(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	list, err := s.Revisions(r.Context(), actor, chi.URLParam(r, "caseKey"))
	if err != nil {
		return err
	}
	return httpx.OK(w, httpx.NewList(list))
}

func (s *Service) handleRevision(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	rev, err := s.Revision(r.Context(), actor, chi.URLParam(r, "caseKey"), chi.URLParam(r, "rev"))
	if err != nil {
		return err
	}
	return httpx.OK(w, rev)
}
