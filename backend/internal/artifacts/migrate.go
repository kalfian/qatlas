package artifacts

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// MigrateOptions configures Migrate.
type MigrateOptions struct {
	// DryRun reports what would be copied without writing or deleting anything.
	DryRun bool
	// DeleteSource removes the source object once the destination holds a copy
	// of the same size (copied now or already present).
	DeleteSource bool
	// Out receives progress lines (nil = io.Discard).
	Out io.Writer
}

// MigrateResult counts what Migrate did.
type MigrateResult struct {
	Total   int   // non-purged artifact rows
	Copied  int   // copied (or, with DryRun, to be copied)
	Skipped int   // destination already had an object of the same size
	Missing int   // in neither store
	Failed  int   // errors (logged to Out)
	Deleted int   // source objects removed (DeleteSource)
	Bytes   int64 // bytes copied
}

// CheckResult counts what Check found.
type CheckResult struct {
	Total    int
	OK       int
	Missing  int
	Mismatch int // object size differs from artifacts.size_bytes
}

type objectRow struct {
	id        uuid.UUID
	key       string
	mime      string
	size      int64
	createdAt time.Time
}

// eachObject visits every non-purged artifact row in (created_at, id) order,
// in batches so no query stays open while objects are transferred.
func eachObject(ctx context.Context, q db.Querier, fn func(objectRow) error) error {
	var (
		afterTime time.Time
		afterID   uuid.UUID
		first     = true
	)
	for {
		rows, err := q.Query(ctx, `
			SELECT id, storage_key, mime, size_bytes, created_at FROM artifacts
			WHERE purged_at IS NULL AND ($1 OR (created_at, id) > ($2, $3))
			ORDER BY created_at, id
			LIMIT 500`, first, afterTime, afterID)
		if err != nil {
			return err
		}
		batch, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (objectRow, error) {
			var o objectRow
			err := r.Scan(&o.id, &o.key, &o.mime, &o.size, &o.createdAt)
			return o, err
		})
		if err != nil {
			return err
		}
		if len(batch) == 0 {
			return nil
		}
		for _, o := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := fn(o); err != nil {
				return err
			}
		}
		last := batch[len(batch)-1]
		afterTime, afterID, first = last.createdAt, last.id, false
	}
}

func countObjects(ctx context.Context, q db.Querier) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM artifacts WHERE purged_at IS NULL`).Scan(&n)
	return n, err
}

// Migrate copies the object of every non-purged artifact from src to dst
// (`qatlas artifacts migrate`). Storage keys are the same in every store, so
// the database is not modified. It is idempotent: objects that already exist
// in dst with the same size are skipped. Per-object failures are reported and
// counted; the returned error is non-nil when any object failed.
func Migrate(ctx context.Context, q db.Querier, src, dst Store, opts MigrateOptions) (MigrateResult, error) {
	out := opts.Out
	if out == nil {
		out = io.Discard
	}
	var res MigrateResult
	total, err := countObjects(ctx, q)
	if err != nil {
		return res, err
	}
	res.Total = total
	i := 0
	err = eachObject(ctx, q, func(o objectRow) error {
		i++
		pos := fmt.Sprintf("[%d/%d]", i, total)
		migrateOne(ctx, src, dst, o, opts, &res, out, pos)
		if i%100 == 0 || i == total {
			fmt.Fprintf(out, "%s progress: %d copied, %d skipped, %d missing, %d failed\n", pos, res.Copied, res.Skipped, res.Missing, res.Failed)
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	if res.Failed > 0 {
		return res, fmt.Errorf("%d artifact(s) failed to migrate", res.Failed)
	}
	return res, nil
}

// migrateOne handles one artifact; failures are counted in res and reported to out.
func migrateOne(ctx context.Context, src, dst Store, o objectRow, opts MigrateOptions, res *MigrateResult, out io.Writer, pos string) {
	fail := func(format string, args ...any) {
		res.Failed++
		fmt.Fprintf(out, "%s FAILED %s: %s\n", pos, o.key, fmt.Sprintf(format, args...))
	}
	dstInfo, dstErr := dst.Stat(ctx, o.key)
	if dstErr != nil && !errors.Is(dstErr, ErrNotFound) {
		fail("destination: %v", dstErr)
		return
	}
	srcInfo, srcErr := src.Stat(ctx, o.key)
	switch {
	case srcErr != nil && !errors.Is(srcErr, ErrNotFound):
		fail("source: %v", srcErr)
		return
	case srcErr != nil && dstErr == nil:
		res.Skipped++ // already moved (e.g. an earlier run with --delete-local)
		return
	case srcErr != nil:
		res.Missing++
		fmt.Fprintf(out, "%s MISSING %s (artifact %s): in neither store\n", pos, o.key, o.id)
		return
	}

	switch {
	case dstErr == nil && dstInfo.Size == srcInfo.Size:
		res.Skipped++
	case opts.DryRun:
		res.Copied++
		res.Bytes += srcInfo.Size
		fmt.Fprintf(out, "%s would copy %s (%s)\n", pos, o.key, formatBytes(srcInfo.Size))
		return
	default:
		if err := copyObject(ctx, src, dst, o.key, o.mime, srcInfo.Size); err != nil {
			fail("%v", err)
			return
		}
		res.Copied++
		res.Bytes += srcInfo.Size
		fmt.Fprintf(out, "%s copied %s (%s)\n", pos, o.key, formatBytes(srcInfo.Size))
	}
	if opts.DeleteSource && !opts.DryRun {
		if err := src.Delete(ctx, o.key); err != nil && !errors.Is(err, ErrNotFound) {
			fail("delete source: %v", err)
			return
		}
		res.Deleted++
	}
}

// copyObject streams one object and checks the copy's size.
func copyObject(ctx context.Context, src, dst Store, key, mime string, size int64) error {
	f, _, err := src.Open(ctx, key)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer f.Close()
	if err := dst.Put(ctx, key, f, size, mime); err != nil {
		return err
	}
	info, err := dst.Stat(ctx, key)
	if err != nil {
		return fmt.Errorf("verify copy: %w", err)
	}
	if info.Size != size {
		return fmt.Errorf("verify copy: %d bytes, want %d", info.Size, size)
	}
	return nil
}

// Check verifies that every non-purged artifact has its object in store
// (`qatlas artifacts check`). Missing objects and size mismatches are
// reported to out.
func Check(ctx context.Context, q db.Querier, store Store, out io.Writer) (CheckResult, error) {
	if out == nil {
		out = io.Discard
	}
	var res CheckResult
	err := eachObject(ctx, q, func(o objectRow) error {
		res.Total++
		info, err := store.Stat(ctx, o.key)
		switch {
		case errors.Is(err, ErrNotFound):
			res.Missing++
			fmt.Fprintf(out, "MISSING  %s  %s\n", o.id, o.key)
		case err != nil:
			return fmt.Errorf("stat %s: %w", o.key, err)
		case info.Size != o.size:
			res.Mismatch++
			fmt.Fprintf(out, "SIZE     %s  %s  (%d bytes, recorded %d)\n", o.id, o.key, info.Size, o.size)
		default:
			res.OK++
		}
		return nil
	})
	return res, err
}

func formatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
