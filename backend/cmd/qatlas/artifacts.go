package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/kalfian/qatlas/backend/internal/artifacts"
	"github.com/kalfian/qatlas/backend/internal/config"
)

const artifactsUsage = `Usage:
  qatlas artifacts migrate --from local --to s3 [--dry-run] [--delete-local]
  qatlas artifacts check [--store local|s3]

Every artifact row records the backend its file is stored on (local or s3).
Admin → Storage → Migrate does the same as "migrate" in the background; this
command is for scripts and large one-off moves.

migrate copies the file of every non-expired artifact stored on --from into --to
(local = QATLAS_DATA_DIR/artifacts, s3 = QATLAS_S3_* when complete, otherwise the
S3 settings saved in Admin → Storage; works in both directions) and switches the
row to --to once the copy is verified, so downloads keep working throughout.
Objects that already exist in the destination with the same size are not copied
again, so it is safe to re-run. Source files are kept unless --delete-local
(--delete-source) is given. Where NEW artifacts go is a separate setting:
Admin → Storage (or QATLAS_STORAGE). Exit status 1 when any object failed.

check verifies that every non-expired artifact has its object in the store of its
backend (--store: only the artifacts on that backend) and lists missing ones.
Exit status 1 when anything is missing, has the wrong size or sits on a backend
that is not configured.
`

func runArtifacts(ctx context.Context, cfg *config.Config, args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Print(artifactsUsage)
		if len(args) == 0 {
			return errors.New("missing artifacts command (migrate | check)")
		}
		return nil
	}
	switch args[0] {
	case "migrate":
		return runArtifactsMigrate(ctx, cfg, args[1:], os.Stdout)
	case "check":
		return runArtifactsCheck(ctx, cfg, args[1:], os.Stdout)
	default:
		fmt.Fprint(os.Stderr, artifactsUsage)
		return fmt.Errorf("unknown artifacts command %q (migrate | check)", args[0])
	}
}

func runArtifactsMigrate(ctx context.Context, cfg *config.Config, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("artifacts migrate", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(fs.Output(), artifactsUsage+"\nFlags:\n"); fs.PrintDefaults() }
	from := fs.String("from", config.StorageLocal, "source store: local | s3")
	to := fs.String("to", config.StorageS3, "destination store: local | s3")
	dryRun := fs.Bool("dry-run", false, "only report what would be copied")
	var deleteSource bool
	fs.BoolVar(&deleteSource, "delete-local", false, "delete each source file once the destination has a verified copy")
	fs.BoolVar(&deleteSource, "delete-source", false, "alias of --delete-local (for --from s3)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	if *from == *to {
		return fmt.Errorf("--from and --to must differ (both %q)", *from)
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	src, err := openStore(ctx, cfg, pool, *from)
	if err != nil {
		return fmt.Errorf("source: %w", err)
	}
	dst, err := openStore(ctx, cfg, pool, *to)
	if err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	if err := checkStores(ctx, src, dst, *dryRun); err != nil {
		return err
	}

	mode := ""
	if *dryRun {
		mode = " (dry run: nothing is written)"
	}
	fmt.Fprintf(out, "migrating artifacts from %s to %s%s\n", describeStore(src), describeStore(dst), mode)
	start := time.Now()
	res, err := artifacts.Migrate(ctx, pool, src, dst, artifacts.MigrateOptions{
		From: *from, To: *to, DryRun: *dryRun, DeleteSource: deleteSource, Out: out,
	})
	copied := "copied"
	if *dryRun {
		copied = "to copy"
	}
	fmt.Fprintf(out, "done in %s: %d artifacts on %s, %d %s (%d bytes), %d already present, %d missing in both stores, %d failed",
		time.Since(start).Round(time.Millisecond), res.Total, *from, res.Copied, copied, res.Bytes, res.Skipped, res.Missing, res.Failed)
	if deleteSource && !*dryRun {
		fmt.Fprintf(out, ", %d source files deleted", res.Deleted)
		if res.DeleteFailed > 0 {
			fmt.Fprintf(out, " (%d could not be deleted)", res.DeleteFailed)
		}
	}
	fmt.Fprintln(out)
	if err == nil && !*dryRun {
		fmt.Fprintf(out, "%d artifacts now point at %s. New artifacts go to the backend selected in Admin → Storage", res.Moved(), *to)
		if cfg.StorageFromEnv {
			fmt.Fprintf(out, " (here: QATLAS_STORAGE=%s from the environment)", cfg.Storage)
		}
		fmt.Fprintln(out, ".")
	}
	return err
}

// checkStores verifies the destination is writable (only reachable for a dry
// run) and the source reachable before touching the database.
func checkStores(ctx context.Context, src, dst artifacts.Store, dryRun bool) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if p, ok := src.(artifacts.Pinger); ok {
		if err := p.Ping(ctx); err != nil {
			return fmt.Errorf("source store: %w", err)
		}
	}
	if dryRun {
		if p, ok := dst.(artifacts.Pinger); ok {
			if err := p.Ping(ctx); err != nil {
				return fmt.Errorf("destination store: %w", err)
			}
		}
		return nil
	}
	if err := artifacts.Verify(ctx, dst); err != nil {
		return fmt.Errorf("destination store: %w", err)
	}
	return nil
}

func runArtifactsCheck(ctx context.Context, cfg *config.Config, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("artifacts check", flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(fs.Output(), artifactsUsage+"\nFlags:\n"); fs.PrintDefaults() }
	kind := fs.String("store", "", "only check the artifacts stored on this backend: local | s3 (default: all, each in its own store)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	if *kind != "" && *kind != config.StorageLocal && *kind != config.StorageS3 {
		return fmt.Errorf("unknown artifact storage %q (local | s3)", *kind)
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	// The stores of every backend that is configured; rows on others are reported.
	set := artifacts.StoreSet{Active: config.StorageLocal}
	for _, b := range artifacts.Backends {
		if *kind != "" && b != *kind {
			continue
		}
		store, err := openStore(ctx, cfg, pool, b)
		if err != nil {
			if b == *kind {
				return err
			}
			fmt.Fprintf(out, "%s storage not configured: %v\n", b, err)
			continue
		}
		if p, ok := store.(artifacts.Pinger); ok {
			pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			err := p.Ping(pctx)
			cancel()
			if err != nil {
				return err
			}
		}
		fmt.Fprintf(out, "checking artifacts on %s: %s\n", b, describeStore(store))
		if b == config.StorageS3 {
			set.S3 = store
		} else {
			set.Local = store
		}
	}
	res, err := artifacts.Check(ctx, pool, set, *kind, out)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%d artifacts: %d ok, %d missing, %d size mismatch, %d on an unconfigured backend\n",
		res.Total, res.OK, res.Missing, res.Mismatch, res.Unavailable)
	if bad := res.Missing + res.Mismatch + res.Unavailable; bad > 0 {
		return fmt.Errorf("%d artifact object(s) missing, wrong size or on an unconfigured backend", bad)
	}
	return nil
}
