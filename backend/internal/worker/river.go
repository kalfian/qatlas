package worker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"github.com/kalfian/qatlas/backend/internal/jobs"
)

// Queues.
const (
	// QueueRuns executes run_execute (WORKER_CONCURRENCY workers).
	QueueRuns = river.QueueDefault
	// QueueMaintenance runs housekeeping (artifact retention), one at a time.
	QueueMaintenance = "maintenance"
)

// ------------------------------------------------------------------ enqueuer

// Enqueuer implements jobs.Enqueuer with River's transactional insert.
type Enqueuer struct {
	client *river.Client[pgx.Tx]
}

var _ jobs.Enqueuer = (*Enqueuer)(nil)

// NewEnqueuer wraps a River client (insert-only or working).
func NewEnqueuer(client *river.Client[pgx.Tx]) *Enqueuer { return &Enqueuer{client: client} }

// EnqueueRun inserts run_execute inside tx. MaxAttempts is 1: a run that executed partly
// must never be replayed blindly — failures end the run in error instead.
func (e *Enqueuer) EnqueueRun(ctx context.Context, tx pgx.Tx, runID uuid.UUID) error {
	_, err := e.client.InsertTx(ctx, tx, jobs.RunExecuteArgs{RunID: runID}, &river.InsertOpts{
		Queue:       QueueRuns,
		MaxAttempts: 1,
	})
	if err != nil {
		return fmt.Errorf("enqueue run_execute: %w", err)
	}
	return nil
}

// NewInsertOnlyClient is the River client of `qatlas server`: it inserts jobs but never
// works them.
func NewInsertOnlyClient(pool *pgxpool.Pool, logger *slog.Logger) (*river.Client[pgx.Tx], error) {
	return river.NewClient(riverpgxv5.New(pool), &river.Config{Logger: riverLogger(logger)})
}

// riverLogger keeps River's own logs at warn and above (it is chatty at info).
func riverLogger(l *slog.Logger) *slog.Logger {
	if l == nil {
		l = slog.Default()
	}
	return slog.New(minLevelHandler{h: l.Handler(), min: slog.LevelWarn}).With("component", "river")
}

type minLevelHandler struct {
	h   slog.Handler
	min slog.Level
}

func (m minLevelHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return l >= m.min && m.h.Enabled(ctx, l)
}
func (m minLevelHandler) Handle(ctx context.Context, r slog.Record) error { return m.h.Handle(ctx, r) }
func (m minLevelHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return minLevelHandler{h: m.h.WithAttrs(a), min: m.min}
}
func (m minLevelHandler) WithGroup(n string) slog.Handler {
	return minLevelHandler{h: m.h.WithGroup(n), min: m.min}
}

// ------------------------------------------------------------------ job workers

// runExecuteWorker works jobs.RunExecuteArgs.
type runExecuteWorker struct {
	river.WorkerDefaults[jobs.RunExecuteArgs]
	exec    *Executor
	timeout time.Duration
}

// Timeout leaves room above the run timeout (enforced inside the executor) for the
// cancel grace period and final writes.
func (w *runExecuteWorker) Timeout(*river.Job[jobs.RunExecuteArgs]) time.Duration { return w.timeout }

func (w *runExecuteWorker) Work(ctx context.Context, job *river.Job[jobs.RunExecuteArgs]) error {
	err := w.exec.Execute(ctx, job.Args.RunID)
	if errors.Is(err, ErrRunBusy) {
		return river.JobSnooze(10 * time.Second) // does not consume the single attempt
	}
	return err
}

// RetentionArgs is the daily artifact retention job.
type RetentionArgs struct{}

// Kind is the River job kind.
func (RetentionArgs) Kind() string { return "artifact_retention" }

type retentionWorker struct {
	river.WorkerDefaults[RetentionArgs]
	purge func(ctx context.Context) (int, error)
	log   *slog.Logger
}

func (w *retentionWorker) Timeout(*river.Job[RetentionArgs]) time.Duration { return time.Hour }

func (w *retentionWorker) Work(ctx context.Context, _ *river.Job[RetentionArgs]) error {
	n, err := w.purge(ctx)
	if err != nil {
		return fmt.Errorf("artifact retention: %w", err)
	}
	w.log.Info("artifact retention done", "purged", n)
	return nil
}

// ------------------------------------------------------------------ migrations

// River's tables live on River's own migration line ("main"), applied by rivermigrate
// right after the goose migrations in `qatlas migrate up`. They are independent of the
// QAtlas schema, so `qatlas migrate down` (one goose step) leaves them in place; use
// MigrateRiverDown to remove them.

func newMigrator(pool *pgxpool.Pool) (*rivermigrate.Migrator[pgx.Tx], error) {
	return rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{
		Logger: slog.New(slog.DiscardHandler),
	})
}

// MigrateRiverUp applies River's pending migrations.
func MigrateRiverUp(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	m, err := newMigrator(pool)
	if err != nil {
		return err
	}
	res, err := m.Migrate(ctx, rivermigrate.DirectionUp, nil)
	if err != nil {
		return fmt.Errorf("river migrate up: %w", err)
	}
	for _, v := range res.Versions {
		fmt.Fprintf(out, "applied river %03d_%s (%s)\n", v.Version, strings.ReplaceAll(v.Name, " ", "_"), v.Duration.Round(time.Millisecond))
	}
	if len(res.Versions) == 0 {
		fmt.Fprintln(out, "no pending river migrations")
	}
	return nil
}

// MigrateRiverDown removes River's schema completely (every River version).
func MigrateRiverDown(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	m, err := newMigrator(pool)
	if err != nil {
		return err
	}
	res, err := m.Migrate(ctx, rivermigrate.DirectionDown, &rivermigrate.MigrateOpts{TargetVersion: -1})
	if err != nil {
		return fmt.Errorf("river migrate down: %w", err)
	}
	for _, v := range res.Versions {
		fmt.Fprintf(out, "rolled back river %03d_%s\n", v.Version, strings.ReplaceAll(v.Name, " ", "_"))
	}
	return nil
}

// RiverStatus prints River's versions in the style of `goose status`.
func RiverStatus(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	m, err := newMigrator(pool)
	if err != nil {
		return err
	}
	applied := map[int]bool{}
	if existing, err := m.ExistingVersions(ctx); err == nil { // error: no river_migration table yet
		for _, v := range existing {
			applied[v.Version] = true
		}
	}
	appliedAt := riverAppliedAt(ctx, pool)
	for _, v := range m.AllVersions() {
		state, at := "pending", "-"
		if applied[v.Version] {
			state = "applied"
			if t, ok := appliedAt[v.Version]; ok {
				at = t.UTC().Format("2006-01-02T15:04:05Z")
			}
		}
		fmt.Fprintf(out, "%-10s %-24s river/%03d_%s\n", state, at, v.Version, strings.ReplaceAll(v.Name, " ", "_"))
	}
	return nil
}

func riverAppliedAt(ctx context.Context, pool *pgxpool.Pool) map[int]time.Time {
	out := map[int]time.Time{}
	rows, err := pool.Query(ctx, `SELECT version, created_at FROM river_migration WHERE line = 'main'`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var v int
		var t time.Time
		if rows.Scan(&v, &t) == nil {
			out[v] = t
		}
	}
	return out
}

// RiverPending reports whether River's schema is missing or behind this binary.
func RiverPending(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	m, err := newMigrator(pool)
	if err != nil {
		return false, err
	}
	res, err := m.Validate(ctx, nil)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P01" { // undefined_table: River never migrated
			return true, nil
		}
		return false, fmt.Errorf("check river migrations: %w", err)
	}
	return !res.OK, nil
}
