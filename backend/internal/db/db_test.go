package db_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/db/testutil"
	"github.com/kalfian/qatlas/backend/migrations"
)

func TestMigrationsRoundTripAndTx(t *testing.T) {
	pool := testutil.DB(t)
	ctx := context.Background()

	if pending, err := db.HasPendingMigrations(ctx, pool); err != nil || pending {
		t.Fatalf("pending=%v err=%v", pending, err)
	}
	// Roll back every migration (each `migrate down` is one step).
	files, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("migration files: %v %v", files, err)
	}
	for range files {
		if err := db.MigrateDown(ctx, pool, io.Discard); err != nil {
			t.Fatalf("down: %v", err)
		}
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename <> 'goose_db_version'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tables left after down: %d %v", n, err)
	}
	if err := db.MigrateUp(ctx, pool, io.Discard); err != nil {
		t.Fatalf("up again: %v", err)
	}

	// WithTx: rollback on error, commit on success.
	id := db.NewID()
	boom := errors.New("boom")
	err = db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, 'a@b.c', 'A')`, id); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	if n != 0 {
		t.Fatal("rollback failed")
	}
	if err := db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, 'a@b.c', 'A')`, id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, 'a@b.c', 'A2')`, db.NewID())
	if !db.IsUniqueViolation(err, "users_email_key") {
		t.Fatalf("expected unique violation, got %v", err)
	}
	// CHECK constraints guard enums and lowercase emails.
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name) VALUES ($1, 'Upper@b.c', 'U')`, db.NewID()); err == nil {
		t.Fatal("uppercase email accepted")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, name, status) VALUES ($1, 'x@b.c', 'X', 'zombie')`, db.NewID()); err == nil {
		t.Fatal("invalid status accepted")
	}
}
