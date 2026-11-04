// Package jobs holds the contract between the HTTP layer (internal/runs) and the worker
// (internal/worker): job argument types and the Enqueuer interface. The worker provides the
// River-backed implementation; tests may use a fake.
package jobs

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RunExecuteArgs asks the worker to execute the next automated segment of a run.
type RunExecuteArgs struct {
	RunID uuid.UUID `json:"run_id"`
}

// Kind is the River job kind.
func (RunExecuteArgs) Kind() string { return "run_execute" }

// Enqueuer inserts jobs inside the caller's transaction (transactional enqueue, docs/02).
type Enqueuer interface {
	EnqueueRun(ctx context.Context, tx pgx.Tx, runID uuid.UUID) error
}

// NoopEnqueuer drops jobs (used when no worker is configured, e.g. in some tests).
type NoopEnqueuer struct{}

func (NoopEnqueuer) EnqueueRun(context.Context, pgx.Tx, uuid.UUID) error { return nil }

// StorageMigrateArgs asks the worker to copy artifacts into the active storage
// backend (Admin → Storage → Migrate); MigrationID is a storage_migrations row.
type StorageMigrateArgs struct {
	MigrationID uuid.UUID `json:"migration_id"`
}

// Kind is the River job kind.
func (StorageMigrateArgs) Kind() string { return "storage_migrate" }

// StorageMigrationEnqueuer is implemented by enqueuers that can start storage
// migrations (the River enqueuer of the worker package). It returns the job id.
type StorageMigrationEnqueuer interface {
	EnqueueStorageMigration(ctx context.Context, tx pgx.Tx, migrationID uuid.UUID) (int64, error)
}
