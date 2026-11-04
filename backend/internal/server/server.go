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
	"strings"
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
	"github.com/kalfian/qatlas/backend/internal/storage"
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
	// Storage resolves the artifact stores (storage.Registry built by cmd, shared
	// with the worker in `qatlas all`; its owner starts and closes it). nil →
	// the server builds its own from Config + database settings and runs its
	// reload listener until Close; with ArtifactStore set, a fixed registry.
	Storage *storage.Registry
	// ArtifactStore (tests) fixes the store for new artifacts: a static
	// registry with it as writer plus the local store, like an env override.
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
	Storage   *storage.Registry
	Artifacts *artifacts.Service
	Runs      *runs.Service
	MCP       *mcp.Server

	ownsStorage bool
}

// New builds services and the router.
func New(deps Deps) (*Server, error) {
	s := &Server{deps: deps}
	s.Auth = auth.New(deps.Pool, deps.Config, deps.Logger)
	s.Users = users.New(deps.Pool, s.Auth)

	reg := deps.Storage
	if reg == nil {
		ls, err := artifacts.NewLocalStore(filepath.Join(deps.Config.DataDir, "artifacts"))
		if err != nil {
			return nil, err
		}
		if deps.ArtifactStore != nil {
			reg = storage.NewStatic(ls, deps.ArtifactStore)
		} else {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			reg, err = storage.New(ctx, storage.Options{Pool: deps.Pool, Config: deps.Config, Logger: deps.Logger, Local: ls})
			cancel()
			if err != nil {
				return nil, err
			}
			reg.Start()
			s.ownsStorage = true
		}
	}
	s.Storage = reg
	enq := deps.Enqueuer
	if enq == nil {
		deps.Logger.Warn("no job enqueuer configured: automated runs stay queued until a worker enqueuer is wired")
		enq = jobs.NoopEnqueuer{}
	}
	s.Events = events.NewHub(deps.Pool.Config().ConnConfig, deps.Logger)
	s.Artifacts = artifacts.New(deps.Pool, reg)
	s.Runs = runs.New(deps.Pool, enq, reg, s.Events, deps.Logger)
	migEnq, _ := enq.(jobs.StorageMigrationEnqueuer)
	storageSvc := storage.NewService(deps.Pool, reg, deps.Config, migEnq, deps.Logger)
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
			storageSvc.Routes(r) // /admin/settings/storage (admin, session only)
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
// SSE subscriptions, the storage listener when the server owns the registry).
// ListenAndServe calls it on shutdown.
func (s *Server) Close() {
	s.Events.Close()
	if s.ownsStorage {
		s.Storage.Close()
	}
}

// readyz reports whether the database and the artifact store are reachable:
// 200 {"status":"ok","database":"ok","storage":"ok","storage_backend":"s3"}, or
// 503 with "status":"unavailable", the failing part set to "error" and a short
// message (details only in the log: /readyz is unauthenticated).
func (s *Server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	backend, store := s.Storage.Writer()
	body := map[string]string{"status": "ok", "database": "ok", "storage": "ok", "storage_backend": backend}
	var problems []string
	if err := s.deps.Pool.Ping(ctx); err != nil {
		body["database"] = "error"
		problems = append(problems, "database unreachable")
	}
	if p, ok := store.(artifacts.Pinger); ok {
		if err := p.Ping(ctx); err != nil {
			s.deps.Logger.WarnContext(ctx, "readyz: artifact storage check failed", "err", err)
			body["storage"] = "error"
			problems = append(problems, "artifact storage unreachable")
		}
	}
	if len(problems) > 0 {
		body["status"] = "unavailable"
		body["error"] = strings.Join(problems, "; ")
		httpx.WriteJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, body)
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
