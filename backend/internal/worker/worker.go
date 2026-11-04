// Package worker executes runs: River jobs (run_execute, artifact retention), the
// supervisor of the long-lived Node runner process (NDJSON protocol, docs/13) and the
// executor that turns runner events into run_cases / run_steps rows, artifacts and
// NOTIFY events.
//
// Modes (cmd/qatlas):
//
//	server  NewInsertOnlyClient + NewEnqueuer: inserts run_execute, never works jobs
//	worker  New(...).Run: recovery, runner supervisor, River workers
//	all     both in one process; the server enqueues through Worker.Client()
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/events"
	"github.com/kalfian/qatlas/backend/internal/runs"
	"github.com/kalfian/qatlas/backend/internal/storage"
)

// Config configures a worker process.
type Config struct {
	Pool      *pgxpool.Pool
	Logger    *slog.Logger
	MasterKey []byte
	// DataDir is QATLAS_DATA_DIR (runner temp dirs live in DataDir/tmp).
	DataDir string
	// Storage resolves the artifact stores: new screenshots and videos go to
	// its writer, retention and storage migrations use each row's backend
	// (storage.Registry, hot-swapped from Admin → Storage).
	Storage artifacts.Stores
	// RunnerCmd is QATLAS_RUNNER_CMD; RunnerDir its working directory ("" = cwd).
	RunnerCmd string
	RunnerDir string
	// RunnerEnv is appended to the runner's environment.
	RunnerEnv []string
	// Concurrency is WORKER_CONCURRENCY (max parallel run_execute jobs).
	Concurrency int
	// RunTimeout is QATLAS_RUN_TIMEOUT.
	RunTimeout time.Duration
	// StopGrace is how long a stopping worker lets running jobs finish before their
	// contexts are cancelled (runs then end in error). Default 10 s.
	StopGrace time.Duration
	// RetentionInterval schedules artifact retention (default 24 h, also on start).
	RetentionInterval time.Duration
	// Executor overrides for tests (poll/grace); zero values use defaults.
	CancelPoll  time.Duration
	CancelGrace time.Duration
}

// Worker is a running worker: River client + runner supervisor + executor.
type Worker struct {
	cfg    Config
	log    *slog.Logger
	client *river.Client[pgx.Tx]
	sup    *Supervisor
	exec   *Executor
}

// New builds the River client (not started yet) and the runner supervisor.
func New(cfg Config) (*Worker, error) {
	if cfg.Pool == nil {
		return nil, errors.New("worker: pool is required")
	}
	if cfg.Storage == nil {
		return nil, errors.New("worker: artifact storage is required")
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 2
	}
	if cfg.RunTimeout <= 0 {
		cfg.RunTimeout = 15 * time.Minute
	}
	if cfg.StopGrace <= 0 {
		cfg.StopGrace = 10 * time.Second
	}
	if cfg.RetentionInterval <= 0 {
		cfg.RetentionInterval = 24 * time.Hour
	}
	log := cfg.Logger.With("component", "worker")

	sup, err := NewSupervisor(SupervisorConfig{
		Command: ResolveRunnerCommand(cfg.RunnerCmd),
		Dir:     cfg.RunnerDir,
		Env:     cfg.RunnerEnv,
		Logger:  cfg.Logger,
	})
	if err != nil {
		return nil, err
	}
	exec := NewExecutor(ExecutorConfig{
		Pool:        cfg.Pool,
		Runner:      sup,
		Stores:      cfg.Storage,
		MasterKey:   cfg.MasterKey,
		DataDir:     cfg.DataDir,
		RunTimeout:  cfg.RunTimeout,
		CancelPoll:  cfg.CancelPoll,
		CancelGrace: cfg.CancelGrace,
		Logger:      cfg.Logger,
	})

	workers := river.NewWorkers()
	jobTimeout := cfg.RunTimeout + 2*time.Minute
	if err := river.AddWorkerSafely(workers, &runExecuteWorker{exec: exec, timeout: jobTimeout}); err != nil {
		return nil, err
	}
	stores := cfg.Storage
	if err := river.AddWorkerSafely(workers, &retentionWorker{
		purge: func(ctx context.Context) (int, error) {
			return artifacts.Purge(ctx, cfg.Pool, stores, time.Now(), cfg.Logger)
		},
		log: log,
	}); err != nil {
		return nil, err
	}
	if err := river.AddWorkerSafely(workers, &storageMigrateWorker{pool: cfg.Pool, stores: stores, log: cfg.Logger}); err != nil {
		return nil, err
	}

	client, err := river.NewClient(riverpgxv5.New(cfg.Pool), &river.Config{
		Logger: riverLogger(cfg.Logger),
		Queues: map[string]river.QueueConfig{
			QueueRuns:        {MaxWorkers: cfg.Concurrency},
			QueueMaintenance: {MaxWorkers: 1},
		},
		Workers:     workers,
		MaxAttempts: 1, // never replay a partly executed run (EnqueueRun also sets it)
		// A job only counts as stuck well after its own timeout.
		RescueStuckJobsAfter: max(time.Hour, jobTimeout+15*time.Minute),
		SoftStopTimeout:      cfg.StopGrace,
		PeriodicJobs: []*river.PeriodicJob{
			river.NewPeriodicJob(river.PeriodicInterval(cfg.RetentionInterval),
				func() (river.JobArgs, *river.InsertOpts) {
					return RetentionArgs{}, &river.InsertOpts{Queue: QueueMaintenance, MaxAttempts: 3}
				},
				&river.PeriodicJobOpts{ID: "artifact_retention", RunOnStart: true}),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("river client: %w", err)
	}
	exec.cfg.Enqueuer = NewEnqueuer(client)
	return &Worker{cfg: cfg, log: log, client: client, sup: sup, exec: exec}, nil
}

// Client is the working River client; in `all` mode the server enqueues through it.
func (w *Worker) Client() *river.Client[pgx.Tx] { return w.client }

// Run recovers stuck runs, starts the runner and River, and blocks until ctx is done.
// Shutdown: River stops fetching, running jobs get StopGrace to finish, then their
// contexts are cancelled (the executor sends run.cancel and marks the runs error); the
// runner's stdin is closed last.
func (w *Worker) Run(ctx context.Context) error {
	if pending, err := RiverPending(ctx, w.cfg.Pool); err != nil {
		return err
	} else if pending {
		return errors.New("the River job tables are missing or outdated; run `qatlas migrate up`")
	}
	if n, err := RecoverStuckRuns(ctx, w.cfg.Pool, w.log); err != nil {
		return fmt.Errorf("startup recovery: %w", err)
	} else if n > 0 {
		w.log.Warn("marked runs interrupted by a previous worker as error", "count", n)
	}
	if n, err := storage.RecoverMigrations(ctx, w.cfg.Pool); err != nil {
		w.log.Warn("storage migration recovery failed", "err", err)
	} else if n > 0 {
		w.log.Warn("marked storage migrations interrupted by a previous worker as failed", "count", n)
	}

	w.sup.Start()
	defer w.sup.Close()

	// River gets its own context: cancelling ctx starts our ordered shutdown instead of
	// River's implicit one.
	if err := w.client.Start(context.WithoutCancel(ctx)); err != nil {
		return fmt.Errorf("start river: %w", err)
	}
	w.log.Info("worker started", "concurrency", w.cfg.Concurrency, "run_timeout", w.cfg.RunTimeout.String())

	<-ctx.Done()
	w.log.Info("worker stopping")
	stopCtx, cancel := context.WithTimeout(context.Background(), w.cfg.StopGrace+w.exec.cfg.CancelGrace+30*time.Second)
	defer cancel()
	if err := w.client.Stop(stopCtx); err != nil {
		w.log.Warn("river did not stop cleanly", "err", err)
	}
	return nil
}

// RecoverStuckRuns marks runs left `running` by a dead worker as error. A run counts as
// live when a worker holds its advisory lock (Executor.Execute) or a run_execute job for
// it is still waiting to be worked. Call it before the worker's River client starts.
func RecoverStuckRuns(ctx context.Context, pool *pgxpool.Pool, log *slog.Logger) (int, error) {
	rows, err := pool.Query(ctx, `
		SELECT r.id, p.key || '-R' || r.seq
		FROM runs r JOIN projects p ON p.id = r.project_id
		WHERE r.status = 'running'
		  AND NOT EXISTS (
			SELECT 1 FROM river_job j
			WHERE j.kind = 'run_execute' AND j.args->>'run_id' = r.id::text
			  AND j.state IN ('available', 'pending', 'retryable', 'scheduled'))`)
	if err != nil {
		return 0, err
	}
	type stuck struct {
		id  string
		key string
	}
	list, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (stuck, error) {
		var s stuck
		err := row.Scan(&s.id, &s.key)
		return s, err
	})
	if err != nil {
		return 0, err
	}
	n := 0
	for _, s := range list {
		ok, err := recoverOne(ctx, pool, s.id, s.key)
		if err != nil {
			return n, err
		}
		if ok {
			n++
			log.Warn("run interrupted by a worker restart marked as error", "run", s.key)
		}
	}
	return n, nil
}

const workerRestartedMessage = "The worker restarted while the run was executing"

func recoverOne(ctx context.Context, pool *pgxpool.Pool, runID, runKey string) (bool, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1, hashtext($2))`, advisoryClass, runID).Scan(&locked); err != nil {
		return false, err
	}
	if !locked {
		return false, nil // a live worker is executing it
	}
	defer func() {
		if _, err := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1, hashtext($2))`, advisoryClass, runID); err != nil {
			_ = conn.Conn().Close(context.WithoutCancel(ctx))
		}
	}()
	tx, err := conn.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	tag, err := tx.Exec(ctx, `
		UPDATE runs SET status = 'error', finished_at = now(), resume_position = NULL,
			error_message = COALESCE(error_message, $2), updated_at = now()
		WHERE id = $1 AND status = 'running'`, runID, workerRestartedMessage)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 0 {
		return false, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE run_steps s SET status = 'skipped'
		FROM run_cases c WHERE c.id = s.run_case_id AND c.run_id = $1 AND s.status IN ('pending', 'running')`, runID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE run_cases SET status = CASE WHEN status = 'running' THEN 'error' ELSE 'skipped' END,
			finished_at = CASE WHEN started_at IS NULL THEN finished_at ELSE now() END
		WHERE run_id = $1 AND status IN ('pending', 'running')`, runID); err != nil {
		return false, err
	}
	id, err := uuid.Parse(runID)
	if err != nil {
		return false, err
	}
	if err := runs.SyncLastRunStatus(ctx, tx, id); err != nil {
		return false, err
	}
	if err := events.Notify(ctx, tx, events.Event{Type: events.RunFinished, RunKey: runKey, Status: "error"}); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
