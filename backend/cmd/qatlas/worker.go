package main

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/server"
	"github.com/kalfian/qatlas/backend/internal/worker"
)

// warnPendingMigrations logs when goose or River migrations are pending.
func warnPendingMigrations(ctx context.Context, pool *pgxpool.Pool, logger *slog.Logger) {
	if pending, err := db.HasPendingMigrations(ctx, pool); err != nil {
		logger.Warn("could not check migrations", "err", err)
	} else if pending {
		logger.Warn("database has pending migrations; run `qatlas migrate up`")
	}
	if pending, err := worker.RiverPending(ctx, pool); err != nil {
		logger.Warn("could not check River migrations", "err", err)
	} else if pending {
		logger.Warn("River job tables are missing or outdated; run `qatlas migrate up` (runs cannot be enqueued)")
	}
}

// connectWorkerPool sizes the pool for the worker: every executing run holds one
// connection for its advisory lock and River keeps a listener connection, so the pgx
// default (max(4, NumCPU)) is too small for higher WORKER_CONCURRENCY. An explicit
// pool_max_conns in QATLAS_DATABASE_URL wins.
func connectWorkerPool(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, error) {
	if err := cfg.RequireDatabase(); err != nil {
		return nil, err
	}
	pc, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(cfg.DatabaseURL, "pool_max_conns") {
		pc.MaxConns = max(pc.MaxConns, int32(2*cfg.WorkerConcurrency+10))
	}
	return db.ConnectConfig(ctx, pc)
}

func newWorker(cfg *config.Config, pool *pgxpool.Pool, store artifacts.Store, logger *slog.Logger) (*worker.Worker, error) {
	return worker.New(worker.Config{
		Pool:        pool,
		Logger:      logger,
		MasterKey:   cfg.MasterKey,
		DataDir:     cfg.DataDir,
		Store:       store,
		RunnerCmd:   cfg.RunnerCmd,
		Concurrency: cfg.WorkerConcurrency,
		RunTimeout:  cfg.RunTimeout,
	})
}

func artifactStore(cfg *config.Config) (artifacts.Store, error) {
	return artifacts.NewLocalStore(filepath.Join(cfg.DataDir, "artifacts"))
}

// runWorker: `qatlas worker`.
func runWorker(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	if err := cfg.RequireMasterKey(); err != nil {
		return err // needed to decrypt environment secrets
	}
	pool, err := connectWorkerPool(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	store, err := artifactStore(cfg)
	if err != nil {
		return err
	}
	w, err := newWorker(cfg, pool, store, logger)
	if err != nil {
		return err
	}
	return w.Run(ctx)
}

// runAll: `qatlas all` — server and worker share one pool and the working River client.
func runAll(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	if err := cfg.RequireMasterKey(); err != nil {
		return err
	}
	pool, err := connectWorkerPool(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	warnPendingMigrations(ctx, pool, logger)
	store, err := artifactStore(cfg)
	if err != nil {
		return err
	}
	w, err := newWorker(cfg, pool, store, logger)
	if err != nil {
		return err
	}
	srv, err := server.New(server.Deps{
		Config: cfg, Pool: pool, Logger: logger,
		Enqueuer:      worker.NewEnqueuer(w.Client()),
		ArtifactStore: store,
	})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errc := make(chan error, 2)
	go func() { errc <- w.Run(ctx) }()
	go func() { errc <- srv.ListenAndServe(ctx) }()
	first := <-errc
	cancel() // one side stopped (signal or failure): stop the other
	second := <-errc
	return errors.Join(first, second)
}
