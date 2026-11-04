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

migrate copies the file of every non-expired artifact from one store to the other
(local = QATLAS_DATA_DIR/artifacts, s3 = QATLAS_S3_*; works in both directions).
Storage keys are identical in both stores, so the database is not changed: switch
QATLAS_STORAGE afterwards and restart server and worker. Objects that already exist
in the destination with the same size are skipped, so it is safe to re-run (e.g.
once more right before switching). Source files are kept unless --delete-local
(--delete-source) is given. Exit status 1 when any object failed.

check verifies that every non-expired artifact row has its object in the store
(default: the active QATLAS_STORAGE) and lists missing ones. Exit status 1 when
anything is missing or has the wrong size.
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
	src, err := openStore(cfg, *from)
	if err != nil {
		return fmt.Errorf("source: %w", err)
	}
	dst, err := openStore(cfg, *to)
	if err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	if err := checkStores(ctx, src, dst, *dryRun); err != nil {
		return err
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	mode := ""
	if *dryRun {
		mode = " (dry run: nothing is written)"
	}
	fmt.Fprintf(out, "migrating artifacts from %s to %s%s\n", describeStore(src), describeStore(dst), mode)
	start := time.Now()
	res, err := artifacts.Migrate(ctx, pool, src, dst, artifacts.MigrateOptions{DryRun: *dryRun, DeleteSource: deleteSource, Out: out})
	copied := "copied"
	if *dryRun {
		copied = "to copy"
	}
	fmt.Fprintf(out, "done in %s: %d artifacts, %d %s (%d bytes), %d already present, %d missing in both stores, %d failed",
		time.Since(start).Round(time.Millisecond), res.Total, res.Copied, copied, res.Bytes, res.Skipped, res.Missing, res.Failed)
	if deleteSource && !*dryRun {
		fmt.Fprintf(out, ", %d source files deleted", res.Deleted)
	}
	fmt.Fprintln(out)
	if err == nil && !*dryRun && *to != cfg.Storage {
		fmt.Fprintf(out, "next: set QATLAS_STORAGE=%s and restart server and worker (re-run this command right before to catch new files)\n", *to)
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
	kind := fs.String("store", cfg.Storage, "store to check: local | s3 (default: QATLAS_STORAGE)")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	store, err := openStore(cfg, *kind)
	if err != nil {
		return err
	}
	if p, ok := store.(artifacts.Pinger); ok {
		pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := p.Ping(pctx)
		cancel()
		if err != nil {
			return err
		}
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	fmt.Fprintf(out, "checking artifacts in %s\n", describeStore(store))
	res, err := artifacts.Check(ctx, pool, store, out)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "%d artifacts: %d ok, %d missing, %d size mismatch\n", res.Total, res.OK, res.Missing, res.Mismatch)
	if res.Missing > 0 || res.Mismatch > 0 {
		return fmt.Errorf("%d artifact object(s) missing or wrong size", res.Missing+res.Mismatch)
	}
	return nil
}
