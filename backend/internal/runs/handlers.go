package runs

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Routes mounts the run endpoints (inside the authenticated group). The SSE
// route writes directly to the connection; the server has no timeout or
// compression middleware, keep it that way for /runs/{runKey}/events.
func (s *Service) Routes(r chi.Router) {
	r.Get("/projects/{key}/runs", httpx.Handle(s.handleList))
	r.Post("/projects/{key}/runs", httpx.Handle(s.handleCreate))
	r.Get("/runs/{runKey}", httpx.Handle(s.handleGet))
	r.Get("/runs/{runKey}/events", httpx.Handle(s.handleEvents))
	r.Get("/runs/{runKey}/junit.xml", httpx.Handle(s.handleJUnit))
	r.Post("/runs/{runKey}/cancel", httpx.Handle(s.handleCancel))
	r.Post("/runs/{runKey}/rerun", httpx.Handle(s.handleRerun))
	r.Patch("/runs/{runKey}/assignee", httpx.Handle(s.handleAssignee))
	r.Put("/runs/{runKey}/cases/{caseId}/steps/{stepId}/manual-result", httpx.Handle(s.handleManualResult))
	r.Post("/runs/{runKey}/cases/{caseId}/attachments", httpx.Handle(s.handleAttachment))
	r.Post("/runs/{runKey}/cases/{caseId}/complete-manual", httpx.Handle(s.handleCompleteManual))
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	pr, err := httpx.ParsePage(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	page, err := s.List(r.Context(), actor, chi.URLParam(r, "key"), ListFilter{
		Status: q.Get("status"), Target: q.Get("target"), Kind: q.Get("kind"), Trigger: q.Get("trigger"),
		From: q.Get("from"), To: q.Get("to"), Page: pr,
	})
	if err != nil {
		return err
	}
	return httpx.OK(w, page)
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
	run, err := s.Create(r.Context(), actor, chi.URLParam(r, "key"), in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusAccepted, run)
	return nil
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	run, err := s.Get(r.Context(), actor, chi.URLParam(r, "runKey"))
	if err != nil {
		return err
	}
	return httpx.OK(w, run)
}

// handleJUnit serves the JUnit XML report of a final run as a download.
func (s *Service) handleJUnit(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	run, body, err := s.JUnit(r.Context(), actor, chi.URLParam(r, "runKey"))
	if err != nil {
		return err
	}
	h := w.Header()
	h.Set("Content-Type", "application/xml; charset=utf-8")
	h.Set("Content-Disposition", `attachment; filename="`+JUnitFilename(run.Key)+`"`)
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
	return nil
}

func (s *Service) handleEvents(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	run, _, _, err := resolveRun(r.Context(), s.pool, actor, chi.URLParam(r, "runKey"), authz.View, false)
	if err != nil {
		return err
	}
	if s.hub == nil {
		return httpx.NewError(http.StatusServiceUnavailable, httpx.CodeInternal, "Live events are not available")
	}
	return events.ServeSSE(w, r, s.hub, run.Key)
}

func (s *Service) handleCancel(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	run, err := s.Cancel(r.Context(), actor, chi.URLParam(r, "runKey"))
	if err != nil {
		return err
	}
	return httpx.OK(w, run)
}

func (s *Service) handleRerun(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in RerunInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	run, err := s.Rerun(r.Context(), actor, chi.URLParam(r, "runKey"), in)
	if err != nil {
		return err
	}
	httpx.WriteJSON(w, http.StatusAccepted, run)
	return nil
}

func (s *Service) handleAssignee(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in struct {
		UserID string `json:"user_id"`
	}
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	run, err := s.SetAssignee(r.Context(), actor, chi.URLParam(r, "runKey"), in.UserID)
	if err != nil {
		return err
	}
	return httpx.OK(w, run)
}

func (s *Service) handleManualResult(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	var in ManualResultInput
	if err := httpx.DecodeJSON(w, r, &in); err != nil {
		return err
	}
	run, err := s.SetManualResult(r.Context(), actor, chi.URLParam(r, "runKey"), chi.URLParam(r, "caseId"), chi.URLParam(r, "stepId"), in)
	if err != nil {
		return err
	}
	return httpx.OK(w, run)
}

// multipartOverhead allows for form boundaries / the run_step_id field on top of the file.
const multipartOverhead = 1 << 20

func (s *Service) handleAttachment(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	if r.ContentLength > MaxAttachmentBytes+multipartOverhead {
		return tooLarge()
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxAttachmentBytes+multipartOverhead)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) || strings.Contains(err.Error(), "request body too large") {
			return tooLarge()
		}
		return httpx.BadRequest("A file is required", httpx.Field("file", "A file is required"))
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	file, hdr, err := r.FormFile("file")
	if err != nil {
		return httpx.BadRequest("A file is required", httpx.Field("file", "A file is required"))
	}
	defer file.Close()
	if hdr.Size > MaxAttachmentBytes {
		return tooLarge()
	}
	mime := hdr.Header.Get("Content-Type")
	art, err := s.AddAttachment(r.Context(), actor, chi.URLParam(r, "runKey"), chi.URLParam(r, "caseId"), AttachmentInput{
		Name: hdr.Filename, MIME: mime, Size: hdr.Size, Body: file, RunStepID: r.FormValue("run_step_id"),
	})
	if err != nil {
		return err
	}
	return httpx.Created(w, art)
}

func (s *Service) handleCompleteManual(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	run, err := s.CompleteManual(r.Context(), actor, chi.URLParam(r, "runKey"), chi.URLParam(r, "caseId"))
	if err != nil {
		return err
	}
	return httpx.OK(w, run)
}
