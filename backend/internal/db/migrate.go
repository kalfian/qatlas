package db

import (
	"context"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"

	"github.com/kalfian/qatlas/backend/migrations"
)

func newProvider(pool *pgxpool.Pool) (*goose.Provider, error) {
	// Advisory lock so concurrent `migrate up` runs (several instances, or
	// parallel test packages) serialise; poll every second for up to 5 minutes.
	locker, err := lock.NewPostgresSessionLocker(lock.WithLockTimeout(1, 300))
	if err != nil {
		return nil, err
	}
	// Closing the *sql.DB from OpenDBFromPool does not close the pool.
	sqlDB := stdlib.OpenDBFromPool(pool)
	return goose.NewProvider(goose.DialectPostgres, sqlDB, migrations.FS, goose.WithSessionLocker(locker))
}

// MigrateUp applies all pending migrations.
func MigrateUp(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	p, err := newProvider(pool)
	if err != nil {
		return err
	}
	defer p.Close()
	res, err := p.Up(ctx)
	for _, r := range res {
		fmt.Fprintf(out, "applied %s (%s)\n", r.Source.Path, r.Duration.Round(1e6))
	}
	if err != nil {
		return fmt.Errorf("migrate up: %w", err)
	}
	if len(res) == 0 {
		fmt.Fprintln(out, "no pending migrations")
	}
	return nil
}

// MigrateDown rolls back the most recent migration.
func MigrateDown(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	p, err := newProvider(pool)
	if err != nil {
		return err
	}
	defer p.Close()
	r, err := p.Down(ctx)
	if err != nil {
		return fmt.Errorf("migrate down: %w", err)
	}
	fmt.Fprintf(out, "rolled back %s\n", r.Source.Path)
	return nil
}

// MigrateStatus prints every migration with its state.
func MigrateStatus(ctx context.Context, pool *pgxpool.Pool, out io.Writer) error {
	p, err := newProvider(pool)
	if err != nil {
		return err
	}
	defer p.Close()
	st, err := p.Status(ctx)
	if err != nil {
		return fmt.Errorf("migrate status: %w", err)
	}
	for _, s := range st {
		applied := "-"
		if !s.AppliedAt.IsZero() {
			applied = s.AppliedAt.UTC().Format("2006-01-02T15:04:05Z")
		}
		fmt.Fprintf(out, "%-10s %-24s %s\n", s.State, applied, s.Source.Path)
	}
	return nil
}

// HasPendingMigrations reports whether the database is behind the embedded migrations.
func HasPendingMigrations(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	p, err := newProvider(pool)
	if err != nil {
		return false, err
	}
	defer p.Close()
	return p.HasPending(ctx)
}
