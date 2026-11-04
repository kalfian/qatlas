// Command qatlas is the single QAtlas binary.
//
//	qatlas server                       HTTP API (+ SPA when QATLAS_WEB_DIR is set)
//	qatlas worker                       job worker (River + Node runner)
//	qatlas all                          server + worker in one process
//	qatlas migrate up|down|status       database migrations (goose, then River)
//	qatlas user create-admin --email … --name … [--password …]
//	qatlas mcp-stdio --url U --token T  MCP stdio proxy to a server's /mcp
//	qatlas seed demo [flags]            load the demo data set (internal/seed)
//	qatlas artifacts migrate|check      copy artifact files local ↔ S3 / verify the active store
//	qatlas version                      print the build version
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/term"

	"github.com/kalfian/qatlas/backend/internal/audit"
	"github.com/kalfian/qatlas/backend/internal/auth"
	"github.com/kalfian/qatlas/backend/internal/config"
	"github.com/kalfian/qatlas/backend/internal/db"
	"github.com/kalfian/qatlas/backend/internal/mcp"
	"github.com/kalfian/qatlas/backend/internal/seed"
	"github.com/kalfian/qatlas/backend/internal/server"
	"github.com/kalfian/qatlas/backend/internal/worker"
)

const usage = `Usage: qatlas <command>

Commands:
  server                                  run the HTTP API (and SPA when QATLAS_WEB_DIR is set)
  worker                                  run the job worker: executes runs with the Node runner
                                          (QATLAS_RUNNER_CMD, WORKER_CONCURRENCY, QATLAS_RUN_TIMEOUT)
  all                                     server + worker in one process
  migrate up|down|status                  up: QAtlas migrations, then River's job tables;
                                          down: roll back the latest QAtlas migration (River's
                                          tables are kept); status: both
  user create-admin --email E --name N [--password P]
                                          create (or reset) an admin; password from --password,
                                          QATLAS_ADMIN_PASSWORD or an interactive prompt
  seed demo [--password P] [--target-url URL] [--mailpit-url URL] [--qa-password P]
            [--qa-totp-seed S] [--admin-token T] [--reset] [--runs]
                                          load the demo users, projects SHOP/PAY, environments,
                                          folders, test cases and flows (skips existing projects);
                                          see "qatlas seed demo --help"
  artifacts migrate --from local --to s3 [--dry-run] [--delete-local]
                                          copy artifact files between stores (QATLAS_S3_*);
                                          idempotent, see "qatlas artifacts --help"
  artifacts check [--store local|s3]      verify every non-expired artifact exists in the store
  mcp-stdio --url URL --token TOKEN       MCP stdio proxy to URL/mcp for stdio-only MCP clients
                                          (or QATLAS_URL / QATLAS_TOKEN)
  version                                 print the version (also --version)

Configuration is read from environment variables; see backend/.env.example.
`

// version is set at build time: go build -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Print(usage)
		return nil
	}
	if args[0] == "version" || args[0] == "--version" || args[0] == "-v" {
		fmt.Println("qatlas", version)
		return nil
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if args[0] == "mcp-stdio" { // client-side proxy: needs no server configuration
		return mcp.RunStdio(ctx, args[1:])
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("invalid configuration:\n%w", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	switch args[0] {
	case "server":
		return runServer(ctx, cfg, logger)
	case "migrate":
		return runMigrate(ctx, cfg, args[1:])
	case "user":
		return runUser(ctx, cfg, args[1:])
	case "worker":
		return runWorker(ctx, cfg, logger)
	case "all":
		return runAll(ctx, cfg, logger)
	case "seed":
		return runSeed(ctx, cfg, logger, args[1:])
	case "artifacts":
		return runArtifacts(ctx, cfg, args[1:])
	default:
		fmt.Fprint(os.Stderr, usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func connect(ctx context.Context, cfg *config.Config) (*pgxpool.Pool, error) {
	if err := cfg.RequireDatabase(); err != nil {
		return nil, err
	}
	return db.Connect(ctx, cfg.DatabaseURL)
}

func runServer(ctx context.Context, cfg *config.Config, logger *slog.Logger) error {
	if err := cfg.RequireMasterKey(); err != nil {
		return err
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	warnPendingMigrations(ctx, pool, logger)
	store, err := artifactStore(ctx, cfg, logger)
	if err != nil {
		return err
	}
	// Insert-only River client: the server enqueues run_execute, a worker works it.
	client, err := worker.NewInsertOnlyClient(pool, logger)
	if err != nil {
		return err
	}
	srv, err := server.New(server.Deps{Config: cfg, Pool: pool, Logger: logger, Enqueuer: worker.NewEnqueuer(client), ArtifactStore: store, Version: version})
	if err != nil {
		return err
	}
	return srv.ListenAndServe(ctx)
}

func runMigrate(ctx context.Context, cfg *config.Config, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: qatlas migrate up|down|status")
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	switch args[0] {
	case "up":
		if err := db.MigrateUp(ctx, pool, os.Stdout); err != nil {
			return err
		}
		return worker.MigrateRiverUp(ctx, pool, os.Stdout)
	case "down":
		return db.MigrateDown(ctx, pool, os.Stdout)
	case "status":
		if err := db.MigrateStatus(ctx, pool, os.Stdout); err != nil {
			return err
		}
		return worker.RiverStatus(ctx, pool, os.Stdout)
	default:
		return fmt.Errorf("unknown migrate command %q (up|down|status)", args[0])
	}
}

func runUser(ctx context.Context, cfg *config.Config, args []string) error {
	if len(args) == 0 || args[0] != "create-admin" {
		return errors.New("usage: qatlas user create-admin --email E --name N [--password P]")
	}
	fs := flag.NewFlagSet("user create-admin", flag.ContinueOnError)
	email := fs.String("email", "", "admin email (required)")
	name := fs.String("name", "", "display name (required)")
	password := fs.String("password", "", "password (or QATLAS_ADMIN_PASSWORD, or prompt)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	*email = strings.ToLower(strings.TrimSpace(*email))
	*name = strings.TrimSpace(*name)
	if *email == "" || !strings.Contains(*email, "@") || *name == "" {
		return errors.New("--email and --name are required")
	}
	pw := *password
	if pw == "" {
		pw = os.Getenv("QATLAS_ADMIN_PASSWORD")
	}
	if pw == "" {
		var err error
		if pw, err = promptPassword(); err != nil {
			return err
		}
	}
	if len(pw) < auth.MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", auth.MinPasswordLength)
	}

	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	var created bool
	err = db.WithTx(ctx, pool, func(tx pgx.Tx) error {
		var u auth.User
		err := tx.QueryRow(ctx, `
			INSERT INTO users AS u (id, email, name, password_hash, system_role, status)
			VALUES ($1, $2, $3, $4, 'admin', 'active')
			ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
				system_role = 'admin', status = 'active', updated_at = now()
			RETURNING u.id, (xmax = 0)`, db.NewID(), *email, *name, hash).Scan(&u.ID, &created)
		if err != nil {
			return err
		}
		action := audit.ActionUserCreate
		if !created {
			action = audit.ActionUserUpdate
		}
		return audit.Record(ctx, tx, nil, action, "user", u.ID.String(), nil,
			audit.Meta{"via": "cli", "email": *email, "system_role": "admin"})
	})
	if err != nil {
		return err
	}
	if created {
		fmt.Printf("created admin %s\n", *email)
	} else {
		fmt.Printf("updated existing user %s: admin, active, password reset\n", *email)
	}
	return nil
}

func promptPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		data, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
		if err != nil {
			return "", err
		}
		return strings.TrimRight(string(data), "\r\n"), nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	p1, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Repeat password: ")
	p2, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(p1) != string(p2) {
		return "", errors.New("passwords do not match")
	}
	return string(p1), nil
}

const seedUsage = `Usage: qatlas seed demo [flags]

Loads the demo data set (users rina/dimas/sari active, budi invited; projects SHOP and PAY
with members, environments, folders, test cases and flows) through the real services.
Projects that already exist are skipped; existing users are left unchanged.
Needs QATLAS_DATABASE_URL and QATLAS_MASTER_KEY (secrets are encrypted).

SHOP "staging" points at the demo target (demo-target/, node demo-target/server.mjs):
BASE_URL=<target-url>, API_URL=<target-url>/api, MAILPIT_URL=<mailpit-url> (the Mailpit the
demo target sends its sign-up email to). Secrets: QA_PASSWORD=--qa-password,
QA_TOTP_SEED=--qa-totp-seed (demo-target DEMO_TOTP_SEED), ADMIN_TOKEN=--admin-token (random when
empty; demo-target accepts DEMO_ADMIN_TOKEN), PAY API_KEY random.

Flags:
`

func runSeed(ctx context.Context, cfg *config.Config, logger *slog.Logger, args []string) error {
	if len(args) == 0 || args[0] != "demo" {
		return errors.New("usage: qatlas seed demo [flags] (see qatlas seed demo --help)")
	}
	fs := flag.NewFlagSet("seed demo", flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprint(fs.Output(), seedUsage)
		fs.PrintDefaults()
	}
	opts := seed.Options{Out: os.Stdout}
	fs.StringVar(&opts.Password, "password", seed.DefaultPassword, "password of the active demo users")
	fs.StringVar(&opts.TargetURL, "target-url", seed.DefaultTargetURL, "demo target base URL for SHOP staging")
	fs.StringVar(&opts.QAPassword, "qa-password", seed.DefaultQAPassword, "value of the QA_PASSWORD secrets (demo-target DEMO_QA_PASSWORD)")
	fs.StringVar(&opts.MailpitURL, "mailpit-url", seed.DefaultMailpitURL, "Mailpit web/API URL for SHOP staging MAILPIT_URL (sign-up email cases)")
	fs.StringVar(&opts.QATOTPSeed, "qa-totp-seed", seed.DefaultQATOTPSeed, "value of the QA_TOTP_SEED secret (demo-target DEMO_TOTP_SEED; the default is a public demo-only seed)")
	fs.StringVar(&opts.AdminToken, "admin-token", "", "value of the ADMIN_TOKEN secret (default: random; demo-target DEMO_ADMIN_TOKEN)")
	fs.BoolVar(&opts.Reset, "reset", false, "delete the demo projects (with all their runs) first")
	fs.BoolVar(&opts.Runs, "runs", false, "enqueue a few demo runs (SHOP-F2, SHOP-T12, SHOP-F3) for a running worker; returns immediately")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	pool, err := connect(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()
	if opts.Runs {
		// Insert-only River client: the runs are executed by `qatlas worker` / `qatlas all`.
		client, err := worker.NewInsertOnlyClient(pool, logger)
		if err != nil {
			return err
		}
		opts.Enqueuer = worker.NewEnqueuer(client)
		if opts.Store, err = artifactStore(ctx, cfg, logger); err != nil {
			return err
		}
	}
	return seed.Demo(ctx, pool, cfg, logger, opts)
}
