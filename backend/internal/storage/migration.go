package storage

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
)

// Migration statuses (StorageMigration.status).
const (
	MigrationQueued  = "queued"
	MigrationRunning = "running"
	MigrationDone    = "done"
	MigrationFailed  = "failed"
)

// Migration is the OpenAPI StorageMigration.
type Migration struct {
	Status     string     `json:"status"`
	From       string     `json:"from"`
	To         string     `json:"to"`
	Total      int        `json:"total"`
	Copied     int        `json:"copied"`
	Failed     int        `json:"failed"`
	StartedAt  *time.Time `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at"`
	Error      *string    `json:"error"`
}

// migrationLock is the advisory lock a running migration job holds (on its
// own connection) for its whole duration; a "running" row whose lock is free
// belongs to a dead worker.
const migrationLock = "qatlas_storage_migration"

// latestMigration returns the newest migration, nil when none.
func latestMigration(ctx context.Context, q db.Querier) (*Migration, error) {
	var m Migration
	err := q.QueryRow(ctx, `
		SELECT status, from_backend, to_backend, total, copied, failed, started_at, finished_at, error
		FROM storage_migrations ORDER BY created_at DESC, id DESC LIMIT 1`).
		Scan(&m.Status, &m.From, &m.To, &m.Total, &m.Copied, &m.Failed, &m.StartedAt, &m.FinishedAt, &m.Error)
	if db.IsNoRows(err) || isUndefinedTable(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.StartedAt, m.FinishedAt = auth.UTCPtr(m.StartedAt), auth.UTCPtr(m.FinishedAt)
	return &m, nil
}

// RecoverMigrations fails migrations left behind by a dead worker: "running"
// rows while no job holds the migration lock, and "queued" rows whose River
// job is gone. Called before starting a migration and when a worker starts.
func RecoverMigrations(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()
	var n int64
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1))`, migrationLock).Scan(&locked); err != nil {
		return 0, err
	}
	if locked {
		tag, err := conn.Exec(ctx, `
			UPDATE storage_migrations SET status = 'failed', finished_at = now(),
				error = 'The worker stopped while the migration was running. Start it again: artifacts already copied are skipped.'
			WHERE status = 'running'`)
		if _, uerr := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext($1))`, migrationLock); uerr != nil {
			_ = conn.Conn().Close(context.WithoutCancel(ctx))
		}
		if err != nil {
			return 0, err
		}
		n += tag.RowsAffected()
	}
	tag, err := pool.Exec(ctx, `
		UPDATE storage_migrations m SET status = 'failed', finished_at = now(),
			error = 'The migration job was lost before it started. Start it again.'
		WHERE m.status = 'queued' AND NOT EXISTS (
			SELECT 1 FROM river_job j WHERE j.id = m.job_id
			  AND j.state IN ('available', 'pending', 'retryable', 'scheduled', 'running'))`)
	if err != nil {
		if isUndefinedTable(err) {
			return n, nil // River not migrated: nothing can have run
		}
		return n, err
	}
	return n + tag.RowsAffected(), nil
}

// RunMigration is the body of the storage_migrate job: it copies every
// artifact stored on the migration's source backend into its destination
// (artifacts.Migrate: verified size, artifacts.storage switched per object,
// optional source delete), keeps total/copied/failed up to date and NOTIFYs
// PayloadMigration. Per-object failures end the migration as "failed" with a
// summary; it can simply be started again.
func RunMigration(ctx context.Context, pool *pgxpool.Pool, stores artifacts.Stores, id uuid.UUID, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	log := logger.With("component", "storage_migration", "migration_id", id)
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1))`, migrationLock).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		finishMigration(ctx, pool, id, MigrationFailed, nil, "Another storage migration is running")
		return nil
	}
	defer func() {
		if _, err := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock(hashtext($1))`, migrationLock); err != nil {
			_ = conn.Conn().Close(context.WithoutCancel(ctx))
		}
	}()

	var from, to string
	var deleteSource bool
	tag, err := pool.Exec(ctx, `UPDATE storage_migrations SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil // unknown, already finished or recovered as lost
	}
	if err := pool.QueryRow(ctx, `SELECT from_backend, to_backend, delete_source FROM storage_migrations WHERE id = $1`, id).
		Scan(&from, &to, &deleteSource); err != nil {
		return err
	}
	if total, err := artifacts.CountObjects(ctx, pool, from); err == nil {
		_, _ = pool.Exec(ctx, `UPDATE storage_migrations SET total = $2 WHERE id = $1`, id, total)
	}
	notifyMigration(ctx, pool)
	log.Info("storage migration started", "from", from, "to", to, "delete_source", deleteSource)

	src, err := stores.For(from)
	if err != nil {
		finishMigration(ctx, pool, id, MigrationFailed, nil, backendMissing(from))
		return nil
	}
	dst, err := stores.For(to)
	if err != nil {
		finishMigration(ctx, pool, id, MigrationFailed, nil, backendMissing(to))
		return nil
	}
	pctx, cancel := context.WithTimeout(ctx, DefaultProbeTimeout)
	perr := artifacts.ProbeError(artifacts.Probe(pctx, dst))
	cancel()
	if perr != nil {
		finishMigration(ctx, pool, id, MigrationFailed, nil, "The destination storage failed its connection check: "+perr.Error())
		return nil
	}

	out := &failureLog{log: log}
	var (
		mu       sync.Mutex
		lastSave time.Time
	)
	progress := func(res artifacts.MigrateResult) {
		mu.Lock()
		defer mu.Unlock()
		if time.Since(lastSave) < 500*time.Millisecond {
			return
		}
		lastSave = time.Now()
		_, _ = pool.Exec(ctx, `UPDATE storage_migrations SET total = $2, copied = $3, failed = $4 WHERE id = $1`,
			id, res.Total, res.Moved(), res.Failed+res.Missing)
		notifyMigration(ctx, pool)
	}
	res, err := artifacts.Migrate(ctx, pool, src, dst, artifacts.MigrateOptions{
		From: from, To: to, DeleteSource: deleteSource, Out: out, Progress: progress,
	})
	status, msg := MigrationDone, ""
	switch {
	case ctx.Err() != nil:
		status, msg = MigrationFailed, "The worker stopped during the migration. Start it again: artifacts already copied are skipped."
	case err != nil && res.Failed+res.Missing+res.DeleteFailed == 0:
		status, msg = MigrationFailed, err.Error()
	case res.Failed+res.Missing > 0:
		status = MigrationFailed
		msg = fmt.Sprintf("%d of %d artifact(s) could not be migrated", res.Failed+res.Missing, res.Total)
		if res.Missing > 0 {
			msg += fmt.Sprintf(" (%d missing in both stores)", res.Missing)
		}
		if first := out.first(); first != "" {
			msg += ". First problem: " + first
		}
	case res.DeleteFailed > 0:
		msg = fmt.Sprintf("All artifacts were copied, but %d source file(s) could not be deleted", res.DeleteFailed)
	}
	finishMigration(ctx, pool, id, status, &res, msg)
	log.Info("storage migration finished", "status", status, "total", res.Total, "copied", res.Copied,
		"already_present", res.Skipped, "missing", res.Missing, "failed", res.Failed, "deleted", res.Deleted)
	return nil
}

func backendMissing(backend string) string {
	if backend == config.StorageS3 {
		return "S3 storage is not configured"
	}
	return "The " + backend + " storage is not available"
}

// finishMigration records the final state (also after ctx was cancelled).
func finishMigration(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID, status string, res *artifacts.MigrateResult, msg string) {
	ctx = context.WithoutCancel(ctx)
	var errMsg *string
	if msg != "" {
		errMsg = &msg
	}
	if res != nil {
		_, _ = pool.Exec(ctx, `
			UPDATE storage_migrations SET status = $2, total = $3, copied = $4, failed = $5, error = $6, finished_at = now()
			WHERE id = $1`, id, status, res.Total, res.Moved(), res.Failed+res.Missing, errMsg)
	} else {
		_, _ = pool.Exec(ctx, `
			UPDATE storage_migrations SET status = $2, error = $3, finished_at = now(), started_at = COALESCE(started_at, now())
			WHERE id = $1`, id, status, errMsg)
	}
	notifyMigration(ctx, pool)
}

func notifyMigration(ctx context.Context, q db.Querier) {
	_, _ = q.Exec(context.WithoutCancel(ctx), `SELECT pg_notify($1, $2)`, Channel, PayloadMigration)
}

// failureLog receives artifacts.Migrate's output: problem lines go to the log
// (the first one is kept for the migration's error message), progress lines
// are dropped.
type failureLog struct {
	log *slog.Logger
	mu  sync.Mutex
	buf bytes.Buffer
	one string
}

func (f *failureLog) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.buf.Write(p)
	for {
		line, err := f.buf.ReadString('\n')
		if err != nil {
			f.buf.Reset()
			f.buf.WriteString(line) // incomplete line: keep for the next Write
			return len(p), nil
		}
		line = strings.TrimSpace(line)
		if strings.Contains(line, " FAILED ") || strings.Contains(line, " MISSING ") {
			f.log.Warn("storage migration: " + line)
			if f.one == "" {
				_, rest, _ := strings.Cut(line, "] ")
				f.one = rest
			}
		}
	}
}

func (f *failureLog) first() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.one
}
