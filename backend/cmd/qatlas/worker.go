package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/server"
	"github.com/kalfian/qatlas/backend/internal/storage"
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

func newWorker(cfg *config.Config, pool *pgxpool.Pool, reg *storage.Registry, logger *slog.Logger) (*worker.Worker, error) {
	return worker.New(worker.Config{
		Pool:        pool,
		Logger:      logger,
		MasterKey:   cfg.MasterKey,
		DataDir:     cfg.DataDir,
		Storage:     reg,
		RunnerCmd:   cfg.RunnerCmd,
		Concurrency: cfg.WorkerConcurrency,
		RunTimeout:  cfg.RunTimeout,
	})
}

// openStorage builds the artifact storage registry of server / worker / all:
// QATLAS_STORAGE in the environment wins and must pass its probe (the process
// refuses to start otherwise); without it the settings from Admin → Storage
// apply, and a broken S3 configuration there only falls back to local storage
// for new artifacts (logged loudly, shown in the UI). It also consumes the
// one-time backfill of migration 0002. The caller Starts and Closes it.
func openStorage(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, logger *slog.Logger) (*storage.Registry, error) {
	if _, err := storage.Backfill(ctx, pool, cfg, logger); err != nil {
		logger.Warn("artifact storage backfill failed", "err", err)
	}
	return storage.New(ctx, storage.Options{Pool: pool, Config: cfg, Logger: logger})
}

// openStore builds a store of the given kind (local | s3) without contacting
// it, for the artifacts CLI. S3 settings come from QATLAS_S3_* when complete,
// else from Admin → Storage (pool may be nil: environment only).
func openStore(ctx context.Context, cfg *config.Config, pool *pgxpool.Pool, kind string) (artifacts.Store, error) {
	switch kind {
	case config.StorageLocal:
		return artifacts.NewLocalStore(filepath.Join(cfg.DataDir, "artifacts"))
	case config.StorageS3:
		envErr := cfg.S3.Validate()
		if envErr == nil {
			return artifacts.NewS3Store(cfg.S3)
		}
		if pool != nil {
			s3cfg, ok, err := storage.StoredS3Config(ctx, pool, cfg.MasterKey)
			if err != nil {
				return nil, fmt.Errorf("S3 settings from Admin → Storage: %w", err)
			}
			if ok {
				return artifacts.NewS3Store(s3cfg)
			}
		}
		return nil, fmt.Errorf("S3 artifact storage is not configured (Admin → Storage, or QATLAS_S3_*):\n%w", envErr)
	default:
		return nil, fmt.Errorf("unknown artifact storage %q (local | s3)", kind)
	}
}

// describeStore names a store for logs and CLI output (never credentials).
func describeStore(s artifacts.Store) string {
	switch st := s.(type) {
	case *artifacts.LocalStore:
		return "local " + st.Root
	case fmt.Stringer:
		return st.String()
	}
	return artifacts.Backend(s)
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
	reg, err := openStorage(ctx, cfg, pool, logger)
	if err != nil {
		return err
	}
	reg.Start() // reload when Admin → Storage changes (LISTEN qatlas_settings)
	defer reg.Close()
	w, err := newWorker(cfg, pool, reg, logger)
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
	reg, err := openStorage(ctx, cfg, pool, logger)
	if err != nil {
		return err
	}
	reg.Start() // one registry for server and worker
	defer reg.Close()
	w, err := newWorker(cfg, pool, reg, logger)
	if err != nil {
		return err
	}
	srv, err := server.New(server.Deps{
		Config: cfg, Pool: pool, Logger: logger,
		Enqueuer: worker.NewEnqueuer(w.Client()),
		Storage:  reg,
		Version:  version,
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
