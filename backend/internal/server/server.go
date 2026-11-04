// Package server wires the HTTP router: middleware, /healthz, /readyz, the
// /api/v1 tree, the MCP endpoint /mcp and (optionally) the SPA.
//
// Mounting a new package (see backend/README.md):
//
//  1. give it `New(deps…) *Service` and `(*Service).Routes(r chi.Router)`;
//  2. construct it in New below and call Routes inside the authenticated group.
package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/environments"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/flows"
	"github.com/kalfian/qatlas/backend/internal/httpx"
	"github.com/kalfian/qatlas/backend/internal/jobs"
	"github.com/kalfian/qatlas/backend/internal/mcp"
	"github.com/kalfian/qatlas/backend/internal/projects"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/testcases"
	"github.com/kalfian/qatlas/backend/internal/users"
	"github.com/kalfian/qatlas/backend/internal/web"
)

// Deps are the shared dependencies handed to every package.
type Deps struct {
	Config *config.Config
	Pool   *pgxpool.Pool
	Logger *slog.Logger
	// Enqueuer inserts run_execute jobs (River insert-only client from the
	// worker package). nil → jobs.NoopEnqueuer: automated runs stay queued.
	Enqueuer jobs.Enqueuer
	// ArtifactStore keeps run files. nil → LocalStore under DataDir/artifacts.
	ArtifactStore artifacts.Store
	// Version is the build version reported by /healthz ("" → "dev").
	Version string
}

// Server is the configured HTTP server.
type Server struct {
	deps      Deps
	handler   http.Handler
	Auth      *auth.Service
	Users     *users.Service
	Events    *events.Hub
	Artifacts *artifacts.Service
	Runs      *runs.Service
	MCP       *mcp.Server
}

// New builds services and the router.
func New(deps Deps) (*Server, error) {
	s := &Server{deps: deps}
	s.Auth = auth.New(deps.Pool, deps.Config, deps.Logger)
	s.Users = users.New(deps.Pool, s.Auth)

	store := deps.ArtifactStore
	if store == nil {
		ls, err := artifacts.NewLocalStore(filepath.Join(deps.Config.DataDir, "artifacts"))
		if err != nil {
			return nil, err
		}
		store = ls
	}
	enq := deps.Enqueuer
	if enq == nil {
		deps.Logger.Warn("no job enqueuer configured: automated runs stay queued until a worker enqueuer is wired")
		enq = jobs.NoopEnqueuer{}
	}
	s.Events = events.NewHub(deps.Pool.Config().ConnConfig, deps.Logger)
	s.Artifacts = artifacts.New(deps.Pool, store)
	s.Runs = runs.New(deps.Pool, enq, store, s.Events, deps.Logger)
	s.MCP = mcp.New(mcp.Deps{
		Pool: deps.Pool, Logger: deps.Logger, Auth: s.Auth, Runs: s.Runs, Artifacts: s.Artifacts,
		Environments: environments.New(deps.Pool, deps.Config.MasterKey), BaseURL: deps.Config.BaseURL,
	})

	r := chi.NewRouter()
	r.Use(httpx.RequestID, httpx.ClientIP(deps.Config.TrustProxy), httpx.AccessLog(deps.Logger), httpx.Recover, securityHeaders)

	version := deps.Version
	if version == "" {
		version = "dev"
	}
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version})
	})
	r.Get("/readyz", s.readyz)

	// MCP (Streamable HTTP, docs/07): API tokens only — no cookies, so no CSRF.
	// Outside /api/v1; long-polls (wait_for_run) like the SSE stream, so no
	// timeout middleware here either.
	r.Handle("/mcp", s.MCP.Handler())

	r.Route("/api/v1", func(api chi.Router) {
		api.Use(httpx.CSRF, s.Auth.Authenticate)
		api.NotFound(httpx.NotFoundHandler)
		api.MethodNotAllowed(httpx.MethodNotAllowedHandler)

		// Public (anonymous allowed).
		s.Auth.Routes(api)

		// Authenticated.
		api.Group(func(r chi.Router) {
			r.Use(auth.RequireAuth)
			s.Users.Routes(r)
			projects.New(deps.Pool).Routes(r)
			environments.New(deps.Pool, deps.Config.MasterKey).Routes(r)
			testcases.New(deps.Pool).Routes(r)
			flows.New(deps.Pool).Routes(r)
			s.Runs.Routes(r) // includes the SSE stream /runs/{runKey}/events: no timeout/compress middleware here
			s.Artifacts.Routes(r)
			// Later packages mount here, e.g.:
			//   projects.New(deps.Pool, …).Routes(r)
			//   testcases.New(deps.Pool, …).Routes(r)
		})
	})

	if deps.Config.WebDir != "" {
		h, err := web.Handler(deps.Config.WebDir)
		if err != nil {
			return nil, err
		}
		r.Handle("/*", h)
	} else {
		r.NotFound(httpx.NotFoundHandler)
	}

	s.handler = r
	return s, nil
}

// Handler returns the root handler (used by tests via httptest).
func (s *Server) Handler() http.Handler { return s.handler }

// Close releases background resources (the events LISTEN connection and open
// SSE subscriptions). ListenAndServe calls it on shutdown.
func (s *Server) Close() { s.Events.Close() }

func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.deps.Pool.Ping(ctx); err != nil {
		httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable", "error": "database unreachable"})
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

// ListenAndServe serves on cfg.HTTPAddr until ctx is cancelled, then shuts
// down gracefully (in-flight requests get up to 15 s).
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.deps.Config.HTTPAddr,
		Handler:           s.handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// No WriteTimeout: SSE streams (/runs/{key}/events) are long-lived.
	}
	// Closing the hub ends every SSE stream so Shutdown does not wait on them.
	srv.RegisterOnShutdown(s.Close)
	errCh := make(chan error, 1)
	go func() {
		s.deps.Logger.Info("http server listening", "addr", srv.Addr)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	s.deps.Logger.Info("shutting down http server")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
