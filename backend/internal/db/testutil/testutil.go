// Package testutil provides an isolated, migrated Postgres for integration tests.
//
// Usage:
//
//	func TestSomething(t *testing.T) {
//		pool := testutil.DB(t) // skips when QATLAS_TEST_DATABASE_URL is unset
//		...
//	}
//
// Every test package gets its own schema (derived from the package directory),
// so `go test ./...` can run packages in parallel against one database. The
// schema is dropped and re-migrated once per test binary, and every call to DB
// truncates all tables. Tests inside one package must therefore NOT use
// t.Parallel() with the database.
package testutil

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kalfian/qatlas/backend/internal/db"
)

// EnvVar names the test database URL variable.
const EnvVar = "QATLAS_TEST_DATABASE_URL"

// keepTables are never truncated (migration bookkeeping).
var keepTables = map[string]bool{
	"goose_db_version": true,
	"river_migration":  true,
}

var (
	once    sync.Once
	pool    *pgxpool.Pool
	initErr error
	schema  string
)

// DB returns a pool bound to this package's private schema, with all tables
// truncated. It skips the test when QATLAS_TEST_DATABASE_URL is unset.
func DB(t testing.TB) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv(EnvVar)
	if url == "" {
		t.Skipf("integration test skipped: set %s (e.g. postgres://qatlas:qatlas@127.0.0.1:55432/qatlas_test?sslmode=disable)", EnvVar)
	}
	once.Do(func() { pool, initErr = setup(url) })
	if initErr != nil {
		t.Fatalf("test database setup: %v", initErr)
	}
	if err := Truncate(context.Background(), pool); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	return pool
}

// Schema returns the private schema name used by this test binary.
func Schema() string { return schema }

func setup(url string) (*pgxpool.Pool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	schema = schemaName()
	admin, err := db.Connect(ctx, url)
	if err != nil {
		return nil, err
	}
	_, err = admin.Exec(ctx, fmt.Sprintf("DROP SCHEMA IF EXISTS %[1]s CASCADE; CREATE SCHEMA %[1]s", pgx.Identifier{schema}.Sanitize()))
	admin.Close()
	if err != nil {
		return nil, fmt.Errorf("recreate schema %s: %w", schema, err)
	}

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 8
	p, err := db.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := db.MigrateUp(ctx, p, io.Discard); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

// Truncate empties every table in the current schema except migration bookkeeping.
func Truncate(ctx context.Context, p *pgxpool.Pool) error {
	rows, err := p.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`)
	if err != nil {
		return err
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	var idents []string
	for _, n := range names {
		if !keepTables[n] {
			idents = append(idents, pgx.Identifier{n}.Sanitize())
		}
	}
	if len(idents) == 0 {
		return nil
	}
	_, err = p.Exec(ctx, "TRUNCATE "+strings.Join(idents, ", ")+" RESTART IDENTITY CASCADE")
	return err
}

var nonIdent = regexp.MustCompile(`[^a-z0-9_]+`)

// schemaName derives a stable, unique schema per package directory
// (go test runs each package binary with the package dir as cwd).
func schemaName() string {
	wd, _ := os.Getwd()
	sum := sha256.Sum256([]byte(wd))
	base := nonIdent.ReplaceAllString(strings.ToLower(filepath.Base(wd)), "_")
	if len(base) > 30 {
		base = base[:30]
	}
	return "test_" + base + "_" + hex.EncodeToString(sum[:4])
}
