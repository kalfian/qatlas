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
	// From and To are the backends ("local" | "s3") of src and dst; empty =
	// Backend(src) / Backend(dst). Only rows with artifacts.storage = From are
	// migrated, and each one is switched to To once dst holds a verified copy.
	From, To string
	// DryRun reports what would be copied without writing or deleting anything.
	DryRun bool
	// DeleteSource removes the source object once the destination holds a copy
	// of the same size (copied now or already present) and the row points at it.
	DeleteSource bool
	// Out receives progress lines (nil = io.Discard).
	Out io.Writer
	// Progress (optional) is called with the running totals after every object.
	Progress func(MigrateResult)
}

// MigrateResult counts what Migrate did.
type MigrateResult struct {
	Total        int   // non-purged artifact rows on the source backend
	Copied       int   // copied (or, with DryRun, to be copied)
	Skipped      int   // destination already had an object of the same size
	Missing      int   // in neither store
	Failed       int   // copy errors (logged to Out); the row stays on the source
	Deleted      int   // source objects removed (DeleteSource)
	DeleteFailed int   // source objects that could not be removed (the row already points at dst)
	Bytes        int64 // bytes copied
}

// Moved is the number of rows now on the destination (copied or already present).
func (r MigrateResult) Moved() int { return r.Copied + r.Skipped }

// CheckResult counts what Check found.
type CheckResult struct {
	Total       int
	OK          int
	Missing     int
	Mismatch    int // object size differs from artifacts.size_bytes
	Unavailable int // the row's backend is not configured
}

type objectRow struct {
	id        uuid.UUID
	key       string
	mime      string
	size      int64
	backend   string
	createdAt time.Time
}

// eachObject visits every non-purged artifact row (only those stored on
// backend unless it is "") in (created_at, id) order, in batches so no query
// stays open while objects are transferred.
func eachObject(ctx context.Context, q db.Querier, backend string, fn func(objectRow) error) error {
	var (
		afterTime time.Time
		afterID   uuid.UUID
		first     = true
	)
	for {
		rows, err := q.Query(ctx, `
			SELECT id, storage_key, mime, size_bytes, storage, created_at FROM artifacts
			WHERE purged_at IS NULL AND ($4 = '' OR storage = $4) AND ($1 OR (created_at, id) > ($2, $3))
			ORDER BY created_at, id
			LIMIT 500`, first, afterTime, afterID, backend)
		if err != nil {
			return err
		}
		batch, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (objectRow, error) {
			var o objectRow
			err := r.Scan(&o.id, &o.key, &o.mime, &o.size, &o.backend, &o.createdAt)
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

// CountObjects returns the number of non-purged artifact rows on backend ("" = all).
func CountObjects(ctx context.Context, q db.Querier, backend string) (int, error) {
	var n int
	err := q.QueryRow(ctx, `SELECT count(*) FROM artifacts WHERE purged_at IS NULL AND ($1 = '' OR storage = $1)`, backend).Scan(&n)
	return n, err
}

// Migrate copies the object of every non-purged artifact stored on opts.From
// from src to dst and switches the row to opts.To (`qatlas artifacts migrate`,
// the storage migration job of Admin → Storage). It is idempotent: objects
// already in dst with the same size are not copied again, and rows already on
// opts.To are not visited. Per-object failures are reported and counted (the
// row stays on the source); the returned error is non-nil when any object
// failed.
func Migrate(ctx context.Context, q db.Querier, src, dst Store, opts MigrateOptions) (MigrateResult, error) {
	out := opts.Out
	if out == nil {
		out = io.Discard
	}
	if opts.From == "" {
		opts.From = Backend(src)
	}
	if opts.To == "" {
		opts.To = Backend(dst)
	}
	var res MigrateResult
	if opts.From == opts.To {
		return res, fmt.Errorf("migrate: source and destination are both %q", opts.From)
	}
	total, err := CountObjects(ctx, q, opts.From)
	if err != nil {
		return res, err
	}
	res.Total = total
	i := 0
	err = eachObject(ctx, q, opts.From, func(o objectRow) error {
		i++
		pos := fmt.Sprintf("[%d/%d]", i, max(total, i))
		migrateOne(ctx, q, src, dst, o, opts, &res, out, pos)
		if opts.Progress != nil {
			opts.Progress(res)
		}
		if i%100 == 0 || i == total {
			fmt.Fprintf(out, "%s progress: %d copied, %d skipped, %d missing, %d failed\n", pos, res.Copied, res.Skipped, res.Missing, res.Failed)
		}
		return nil
	})
	if err != nil {
		return res, err
	}
	if opts.DeleteSource && !opts.DryRun {
		// Rows moved by an earlier run without DeleteSource: remove their
		// leftover source objects once the destination holds the same size.
		err = eachObject(ctx, q, opts.To, func(o objectRow) error {
			cleanupSource(ctx, src, dst, o, &res, out)
			if opts.Progress != nil {
				opts.Progress(res)
			}
			return nil
		})
		if err != nil {
			return res, err
		}
	}
	switch {
	case res.Failed > 0 && res.DeleteFailed > 0:
		return res, fmt.Errorf("%d artifact(s) failed to migrate, %d source object(s) could not be deleted", res.Failed, res.DeleteFailed)
	case res.Failed > 0:
		return res, fmt.Errorf("%d artifact(s) failed to migrate", res.Failed)
	case res.DeleteFailed > 0:
		return res, fmt.Errorf("%d source object(s) could not be deleted", res.DeleteFailed)
	}
	return res, nil
}

// migrateOne handles one artifact; failures are counted in res and reported to out.
func migrateOne(ctx context.Context, q db.Querier, src, dst Store, o objectRow, opts MigrateOptions, res *MigrateResult, out io.Writer, pos string) {
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
	copied := false
	switch {
	case srcErr != nil && !errors.Is(srcErr, ErrNotFound):
		fail("source: %v", srcErr)
		return
	case srcErr != nil && dstErr == nil:
		// Already moved (e.g. an earlier run with --delete-source): just point the row at it.
		res.Skipped++
		if !opts.DryRun {
			if _, err := switchRow(ctx, q, dst, o, opts, false); err != nil {
				res.Skipped--
				fail("update artifact row: %v", err)
			}
		}
		return
	case srcErr != nil:
		res.Missing++
		fmt.Fprintf(out, "%s MISSING %s (artifact %s): in neither store\n", pos, o.key, o.id)
		return
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
		copied = true
		res.Copied++
		res.Bytes += srcInfo.Size
		fmt.Fprintf(out, "%s copied %s (%s)\n", pos, o.key, formatBytes(srcInfo.Size))
	}
	if opts.DryRun {
		return
	}
	switched, err := switchRow(ctx, q, dst, o, opts, copied)
	if err != nil {
		fail("update artifact row: %v", err)
		return
	}
	if !switched {
		return // purged or moved meanwhile: the source belongs to whoever owns the row now
	}
	if opts.DeleteSource {
		if err := src.Delete(ctx, o.key); err != nil && !errors.Is(err, ErrNotFound) {
			res.DeleteFailed++
			fmt.Fprintf(out, "%s DELETE FAILED %s: %v\n", pos, o.key, err)
			return
		}
		res.Deleted++
	}
}

// cleanupSource deletes the source object of a row already on the
// destination when the destination holds an object of the same size.
func cleanupSource(ctx context.Context, src, dst Store, o objectRow, res *MigrateResult, out io.Writer) {
	srcInfo, err := src.Stat(ctx, o.key)
	if err != nil {
		return // nothing left behind (or unreadable: leave it)
	}
	dstInfo, err := dst.Stat(ctx, o.key)
	if err != nil || dstInfo.Size != srcInfo.Size {
		return
	}
	if err := src.Delete(ctx, o.key); err != nil && !errors.Is(err, ErrNotFound) {
		res.DeleteFailed++
		fmt.Fprintf(out, "DELETE FAILED %s: %v\n", o.key, err)
		return
	}
	res.Deleted++
}

// switchRow points the artifact row at opts.To. It reports false when the row
// was purged or changed meanwhile; a copy made for a purged row is removed.
func switchRow(ctx context.Context, q db.Querier, dst Store, o objectRow, opts MigrateOptions, copied bool) (bool, error) {
	tag, err := q.Exec(ctx, `UPDATE artifacts SET storage = $3 WHERE id = $1 AND storage = $2 AND purged_at IS NULL`, o.id, opts.From, opts.To)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	var purged bool
	err = q.QueryRow(ctx, `SELECT purged_at IS NOT NULL FROM artifacts WHERE id = $1`, o.id).Scan(&purged)
	if (db.IsNoRows(err) || (err == nil && purged)) && copied {
		_ = dst.Delete(context.WithoutCancel(ctx), o.key)
	}
	return false, nil
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

// Check verifies that every non-purged artifact (only those stored on backend
// unless it is "") has its object in the store of its row's backend (`qatlas
// artifacts check`). Missing objects, size mismatches and rows whose backend
// is not configured are reported to out.
func Check(ctx context.Context, q db.Querier, stores Stores, backend string, out io.Writer) (CheckResult, error) {
	if out == nil {
		out = io.Discard
	}
	var res CheckResult
	err := eachObject(ctx, q, backend, func(o objectRow) error {
		res.Total++
		store, err := stores.For(o.backend)
		if err != nil {
			res.Unavailable++
			fmt.Fprintf(out, "NO STORE %s  %s  (stored on %s, which is not configured)\n", o.id, o.key, o.backend)
			return nil
		}
		info, err := store.Stat(ctx, o.key)
		switch {
		case errors.Is(err, ErrNotFound):
			res.Missing++
			fmt.Fprintf(out, "MISSING  %s  %s  (%s)\n", o.id, o.key, o.backend)
		case err != nil:
			return fmt.Errorf("stat %s: %w", o.key, err)
		case info.Size != o.size:
			res.Mismatch++
			fmt.Fprintf(out, "SIZE     %s  %s  (%s: %d bytes, recorded %d)\n", o.id, o.key, o.backend, info.Size, o.size)
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
