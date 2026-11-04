package worker

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
)

func TestRiverMigrationsAndEnqueuer(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()

	var out bytes.Buffer
	if err := MigrateRiverUp(ctx, pool, &out); err != nil {
		t.Fatal(err)
	}
	if pending, err := RiverPending(ctx, pool); err != nil || pending {
		t.Fatalf("pending after up: %v %v", pending, err)
	}
	out.Reset()
	if err := MigrateRiverUp(ctx, pool, &out); err != nil || !strings.Contains(out.String(), "no pending river migrations") {
		t.Fatalf("second up: %v %q", err, out.String())
	}
	out.Reset()
	if err := RiverStatus(ctx, pool, &out); err != nil || hasLinePrefix(out.String(), "pending") || !hasLinePrefix(out.String(), "applied") {
		t.Fatalf("status: %v\n%s", err, out.String())
	}

	// The insert-only client enqueues run_execute transactionally with max_attempts 1.
	client, err := NewInsertOnlyClient(pool, nil)
	if err != nil {
		t.Fatal(err)
	}
	runID := uuid.New()
	err = db.WithTx(ctx, pool, func(tx pgx.Tx) error { return NewEnqueuer(client).EnqueueRun(ctx, tx, runID) })
	if err != nil {
		t.Fatal(err)
	}
	var kind, queue string
	var maxAttempts int
	if err := pool.QueryRow(ctx, `SELECT kind, queue, max_attempts FROM river_job WHERE args->>'run_id' = $1`, runID.String()).
		Scan(&kind, &queue, &maxAttempts); err != nil {
		t.Fatal(err)
	}
	if kind != "run_execute" || queue != QueueRuns || maxAttempts != 1 {
		t.Fatalf("job: %s %s %d", kind, queue, maxAttempts)
	}
	// A rolled back transaction leaves no job behind.
	_ = db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		_ = NewEnqueuer(client).EnqueueRun(ctx, tx, uuid.New())
		return pgx.ErrTxClosed
	})
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM river_job`).Scan(&n)
	if n != 1 {
		t.Fatalf("jobs = %d, want 1", n)
	}

	// Down removes River's schema completely; up restores it.
	out.Reset()
	if err := MigrateRiverDown(ctx, pool, &out); err != nil {
		t.Fatal(err)
	}
	if pending, _ := RiverPending(ctx, pool); !pending {
		t.Fatal("River must be pending after down")
	}
	out.Reset()
	if err := RiverStatus(ctx, pool, &out); err != nil || hasLinePrefix(out.String(), "applied") || !hasLinePrefix(out.String(), "pending") {
		t.Fatalf("status after down: %v\n%s", err, out.String())
	}
	if err := MigrateRiverUp(ctx, pool, &out); err != nil {
		t.Fatal(err)
	}
}

func hasLinePrefix(s, prefix string) bool {
	for _, l := range strings.Split(s, "\n") {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}
