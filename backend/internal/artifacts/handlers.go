package artifacts

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/authz"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/httpx"
)

// Service serves artifact files.
type Service struct {
	pool  *pgxpool.Pool
	store Store
}

// New builds the service.
func New(pool *pgxpool.Pool, store Store) *Service {
	return &Service{pool: pool, store: store}
}

// Store returns the underlying blob store (shared with runs and the worker).
func (s *Service) Store() Store { return s.store }

// Routes mounts GET /artifacts/{id}.
func (s *Service) Routes(r chi.Router) {
	r.Get("/artifacts/{id}", httpx.Handle(s.handleGet))
}

// Open checks that actor may view the artifact's project and opens the file.
// Errors: 404 unknown / inaccessible, 403 role or token scope, 410 purged.
func (s *Service) Open(ctx context.Context, actor *auth.Actor, id string) (Artifact, io.ReadSeekCloser, Info, error) {
	notFound := httpx.NotFound("Artifact not found")
	aid, err := uuid.Parse(id)
	if err != nil {
		return Artifact{}, nil, Info{}, notFound
	}
	var (
		projectKey string
		key        string
	)
	row := s.pool.QueryRow(ctx, `
		SELECT `+Columns+`, p.key, a.storage_key
		FROM artifacts a JOIN projects p ON p.id = a.project_id
		WHERE a.id = $1`, aid)
	var r Row
	err = row.Scan(&r.ID, &r.Kind, &r.Name, &r.MIME, &r.SizeBytes, &r.Expired, &r.RunStepID, &r.CreatedAt, &r.RunCaseID, &projectKey, &key)
	if db.IsNoRows(err) {
		return Artifact{}, nil, Info{}, notFound
	}
	if err != nil {
		return Artifact{}, nil, Info{}, err
	}
	r.URL = URLFor(r.ID)
	r.CreatedAt = r.CreatedAt.UTC()
	if _, _, err := authz.ProjectAccess(ctx, s.pool, actor, projectKey, authz.View); err != nil {
		var apiErr *httpx.APIError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
			return Artifact{}, nil, Info{}, notFound
		}
		return Artifact{}, nil, Info{}, err
	}
	if r.Expired {
		return r.Artifact, nil, Info{}, httpx.Expired("This artifact has expired and was removed by the retention policy")
	}
	f, info, err := s.store.Open(ctx, key)
	if errors.Is(err, ErrNotFound) {
		return r.Artifact, nil, Info{}, httpx.NotFound("Artifact file is missing")
	}
	if err != nil {
		return r.Artifact, nil, Info{}, err
	}
	return r.Artifact, f, info, nil
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) error {
	actor, err := auth.MustActor(r.Context())
	if err != nil {
		return err
	}
	a, f, _, err := s.Open(r.Context(), actor, chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	defer f.Close()

	h := w.Header()
	ctype := a.MIME
	if ctype == "" {
		ctype = DefaultMIME
	}
	h.Set("Content-Type", ctype)
	disposition := "attachment"
	if inlineSafe(ctype) {
		disposition = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": a.Name}))
	// User uploads are served from the app origin: never let them run script.
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "private, max-age=3600")
	h.Set("ETag", `"`+a.ID.String()+`"`)
	// ServeContent handles Range / If-Range / If-None-Match / HEAD.
	http.ServeContent(w, r, a.Name, a.CreatedAt, f)
	return nil
}

// inlineSafe reports content types the browser may render in place.
func inlineSafe(ctype string) bool {
	mt, _, err := mime.ParseMediaType(ctype)
	if err != nil {
		return false
	}
	switch {
	case mt == "image/svg+xml":
		return true // CSP sandbox above neutralises scripts
	case strings.HasPrefix(mt, "image/"), strings.HasPrefix(mt, "video/"), strings.HasPrefix(mt, "audio/"):
		return true
	case mt == "text/plain", mt == "application/pdf", mt == "application/json":
		return true
	}
	return false
}
