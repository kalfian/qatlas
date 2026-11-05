# QAtlas backend

Go module `github.com/kalfian/qatlas/backend` (Go 1.27). One binary, `qatlas`.
Binding conventions: [`docs/13-implementation-guide.md`](../docs/13-implementation-guide.md);
shapes: [`api/openapi.yaml`](../api/openapi.yaml); behaviour: `web/src/mocks/handlers.ts`.

## Run locally

```sh
docker compose -f deploy/docker-compose.dev.yml up -d      # Postgres on 127.0.0.1:55432
cd backend
cp .env.example .env   # fill QATLAS_DATABASE_URL, QATLAS_MASTER_KEY (openssl rand -base64 32)
set -a; . ./.env; set +a

go run ./cmd/qatlas migrate up
go run ./cmd/qatlas user create-admin --email admin@qatlas.local --name Admin   # prompts for the password
go run ./cmd/qatlas server                                                       # :8090
go run ./cmd/qatlas worker        # executes runs (needs the built runner, see below)
# or both in one process:  go run ./cmd/qatlas all
```

Demo data instead of an empty instance (needs the demo target for runs: `node demo-target/server.mjs`):

```sh
go run ./cmd/qatlas seed demo --admin-token adm_stg_8f3a   # rina@tokoku.id / password123 (admin), dimas@, sari@
go run ./cmd/qatlas seed demo --help                        # --password --target-url --qa-password --reset --runs
```

Talking to the API with curl: every non-GET request authenticated by cookie (and
login / invite accept) needs `X-QAtlas-CSRF: 1`; Bearer-token requests are exempt.

```sh
curl -c jar -H 'X-QAtlas-CSRF: 1' -H 'Content-Type: application/json' \
  -d '{"email":"admin@qatlas.local","password":"…"}' localhost:8090/api/v1/auth/login
curl -b jar localhost:8090/api/v1/me
```

## Test

```sh
gofmt -l . && go vet ./...
QATLAS_TEST_DATABASE_URL='postgres://qatlas:qatlas@127.0.0.1:55432/qatlas_test?sslmode=disable' go test ./...
```

S3 tests (`internal/artifacts`, `internal/server`) call `s3test.Config(t)`: it starts one
single-node Garage container (`dxflrs/garage:v2.5.0`, random host port, removed by `TestMain` →
`s3test.Main`) per test binary, or uses an existing bucket from `QATLAS_TEST_S3_ENDPOINT`,
`_REGION`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY` (`_PREFIX`, default `qatlas-test`). Each call
gets its own key prefix, deleted afterwards. Without Docker (and without those variables) the
tests skip. A test binary killed hard can leave a container: `docker rm -f $(docker ps -aq
--filter label=qatlas-test=garage)`.

Integration tests call `testutil.DB(t)`: it skips without `QATLAS_TEST_DATABASE_URL`,
gives each test **package** its own schema (dropped + migrated once per test binary)
and truncates every table per call. Packages can therefore run in parallel; tests
inside one package must not use `t.Parallel()` against the DB. End-to-end HTTP
tests live in `internal/server` (`harness_test.go` has the cookie/Bearer client and
fixtures — extend it rather than writing a second harness).

## Layout

| Package | Role |
|---|---|
| `cmd/qatlas` | subcommands `server`, `worker`, `all`, `migrate up\|down\|status` (+ storage backfill), `user create-admin`, `seed demo`, `artifacts migrate\|check`, `mcp-stdio --url --token` (stdio→HTTP MCP proxy), `version` (`-X main.version=…`, also in `/healthz`) |
| `internal/seed` | `qatlas seed demo`: loads `demo.json` (exported from `web/src/mocks/seed.ts`) through the real services (keys, revisions, validation, audit, encrypted secrets); idempotent per project key, `--reset`, async `--runs` |
| `migrations` | embedded goose SQL. `0001_init.sql` = full schema (all docs/03 entities). Add `0002_….sql`; never edit a shipped file. River's tables are **not** goose files (see "Worker") |
| `internal/config` | env config + validation (`Load`, `RequireDatabase`, `RequireMasterKey`) |
| `internal/db` | `Connect`, `Querier` (pool or tx), `WithTx`, `NewID` (uuid v7 — tables have no id default), `IsUniqueViolation`, migrations; `db/testutil` |
| `internal/httpx` | `Handle` (handlers return `error`), `WriteJSON`/`OK`/`Created`/`NoContent`, `DecodeJSON`, `Optional[T]` (absent vs null in PATCH), `APIError` + constructors + `WriteError`, middleware (request id, client IP, access log, recover, CSRF), pagination (`ParsePage`, `NewPage`, `Paginate`) |
| `internal/auth` | argon2id, sessions (`qatlas_session`, 7 d idle / 30 d max), login + rate limit, invites, Google OIDC + Admin → Google sign-in settings (`/admin/settings/google-auth`), API tokens, `Actor` + middleware (`Authenticate`, `RequireAuth`, `RequireSession`, `RequireMethodScope`, `RequireScope`) |
| `internal/authz` | `Can` (port of permissions.ts), `Scope(action)`, `ProjectAccess`, `ParseEntityKey` |
| `internal/audit` | `Record(ctx, q, actor, action, entityType, entityID, projectID, meta)` — call inside the same tx |
| `internal/users` | `/me`, `/me/tokens`, `/me/manual-runs`, `/admin/users` |
| `internal/runs` | so far only the `RunSummary` read model (`QuerySummaries`) |
| `internal/mcp` | MCP server at `/mcp` (official go-sdk, Streamable HTTP, stateless, API tokens only): 19 tools calling the same services, resource `qatlas://docs/step-dsl` + test case template, prompts `write_test_case` / `triage_failed_run`, per-token limit of 3 queued/running MCP runs, `mcp.tool_call` audit entries; `stdio.go` = `qatlas mcp-stdio`. Spec: docs/07-mcp.md |
| `internal/server` | router + graceful shutdown; `internal/web` serves `QATLAS_WEB_DIR` with SPA fallback |
| `internal/artifacts` | `Store` (`Put`/`Open`/`Stat`/`Delete`, same keys everywhere): `LocalStore` (`QATLAS_DATA_DIR/artifacts`) and `S3Store` (minio-go; `Open` = lazy ranged GETs ≤ 8 MiB pinned to the ETag, so `http.ServeContent` Range works without downloading the whole object). `Stores` resolves a backend's store (`Writer` for new files, `For(row.storage)` for reads/deletes; `StoreSet`/`Single` = fixed sets). `Probe` (connect/bucket/write/read/delete) and `Verify`, `Save`/`SaveFile`/`SaveWith` (record `artifacts.storage`), `Purge`, `Migrate`/`Check` (per-row backend; CLI + UI job), `GET /artifacts/{id}` (RBAC + Range + CSP sandbox, 503 `storage_unavailable`); `s3test` = Garage container for tests |
| `internal/storage` | Admin → Storage: settings in `system_settings` (S3 secret sealed with the master key, write-only), `Registry` (atomic store swap, LISTEN `qatlas_settings` + reload, `OnNotify` for other payloads such as `google_auth`, S3 fallback re-check), `/admin/settings/storage` GET/PUT + `/test` + `/migrate`, `RunMigration` (River `storage_migrate`), `Backfill` (one-time `artifacts.storage` backfill for former `QATLAS_STORAGE=s3` installs) |
| `internal/worker` | River (`NewEnqueuer`, `NewInsertOnlyClient`, River migrations), runner `Supervisor` (NDJSON), `Executor` (run_execute), startup recovery, artifact retention job |

## Worker

- **Modes:** `server` enqueues `run_execute` with an insert-only River client; `worker` works
  jobs (`WORKER_CONCURRENCY` parallel runs over one long-lived runner process); `all` = both,
  sharing one pool and the working client. The worker needs `QATLAS_MASTER_KEY` (secrets) and
  the built runner: `corepack pnpm --filter @qatlas/runner build` (+ Playwright browsers).
- **Runner command:** `QATLAS_RUNNER_CMD` (default `node runner/dist/main.js`, split on
  whitespace). A relative script path that does not exist is looked up in the parent
  directories, so the default works from the repo root and from `backend/`.
- **River migrations:** `qatlas migrate up` runs goose, then River's own migrator
  (`rivermigrate`, line `main`, tracked in `river_migration`) — River's SQL is never copied
  into `migrations/`, so a River upgrade only needs `migrate up`. `migrate status` lists both;
  `migrate down` rolls back one goose migration and leaves River's tables (they do not depend
  on the QAtlas schema; `worker.MigrateRiverDown` removes them). `server`/`all` warn and
  `worker` refuses to start while River's schema is missing or outdated. Integration tests
  that need River call `worker.MigrateRiverUp` on the test pool (testutil only runs goose).
- **Execution** (`internal/worker/executor.go`): a job takes a per-run advisory lock
  (duplicate jobs snooze), runs the next segment of consecutive automated cases with one
  `run.start` (artifact_dir `QATLAS_DATA_DIR/tmp/<run_id>`, always removed), streams events
  into `run_cases`/`run_steps` (secrets masked again, screenshots/videos via
  `artifacts.SaveFile`, NOTIFY per event) and then hands over to `runs.Continue`
  (manual case → `awaiting_manual`, stop_on_failure, finalize). Cancel: `cancel_requested`
  is polled every second → `run.cancel`, 5 s grace. `QATLAS_RUN_TIMEOUT` (default 15m, or
  a smaller `options.run_timeout_ms`) → `run.cancel` and status `error`. Runner crash, panic,
  timeout or shutdown ⇒ interrupted case `error`, the rest `skipped`, run `error` with a
  message; jobs have `max_attempts = 1` and are never replayed.
- **Recovery:** on start, runs left `running` with no lock holder and no waiting job are set
  to `error` ("The worker restarted while the run was executing").
- **Retention:** River periodic job `artifact_retention` (daily + on start, queue
  `maintenance`) calls `artifacts.Purge`.
- **Storage migration:** `storage_migrate` (queue `maintenance`, one attempt, 24 h timeout)
  runs `storage.RunMigration`; it holds an advisory lock, so `storage.RecoverMigrations`
  (worker start, before each new migration) fails rows left `running` by a dead worker.

## Artifact storage

Configure storage from **Admin → Storage** (recommended); env vars override. Precedence:
non-empty `QATLAS_STORAGE` → environment (`source: env`, PUT 409 `env_override`, startup probe
must pass); else the database row (`source: database`); else local (`source: default`). The
local store always exists. `server`, `worker` and `all` build one `storage.Registry`
(`all` shares it), call `Start()` (LISTEN + retry loop) and pass it everywhere a store is
needed; uploads take `Writer()` once, reads use the row's `artifacts.storage`. A PUT probes
first, saves in one tx with the audit row + `pg_notify('qatlas_settings','storage')`, then
installs the stores locally; other processes reload on the notification (skipped when
`updated_at` is unchanged). A DB-configured S3 that fails its probe at startup only
falls back to local for new writes (`warning` in GET, re-probed every minute).

## Adding a package (the pattern)

1. **Service** — `internal/<pkg>/service.go`:

   ```go
   type Service struct{ pool *pgxpool.Pool /* + deps */ }
   func New(pool *pgxpool.Pool /* … */) *Service

   // Business methods take ctx + actor + input and return DTOs or *httpx.APIError.
   // REST handlers and MCP tools both call these.
   func (s *Service) Create(ctx context.Context, actor *auth.Actor, key string, in Input) (DTO, error) {
       var out DTO
       err := db.WithTx(ctx, s.pool, func(tx pgx.Tx) error {
           p, _, err := authz.ProjectAccess(ctx, tx, actor, key, authz.EditTests) // 404/403 + token scope
           if err != nil { return err }
           // … UPDATE projects SET seq_case = seq_case + 1 WHERE id = $1 RETURNING seq_case
           // … INSERT … (ids from db.NewID())
           return audit.Record(ctx, tx, actor, "test_case.create", "test_case", key, &p.ID, audit.Meta{…})
       })
       return out, err
   }
   ```

2. **Handlers** — `internal/<pkg>/handlers.go`:

   ```go
   func (s *Service) Routes(r chi.Router) {
       r.Post("/projects/{key}/test-cases", httpx.Handle(s.handleCreate))
   }
   func (s *Service) handleCreate(w http.ResponseWriter, r *http.Request) error {
       actor, err := auth.MustActor(r.Context())
       if err != nil { return err }
       var in Input
       if err := httpx.DecodeJSON(w, r, &in); err != nil { return err }
       out, err := s.Create(r.Context(), actor, chi.URLParam(r, "key"), in)
       if err != nil { return err }
       return httpx.Created(w, out)
   }
   ```

3. **Mount** — in `internal/server/server.go`, inside the authenticated group:
   `projects.New(deps.Pool).Routes(r)`.

Rules of thumb:

- Project-scoped endpoints authorise **only** through `authz.ProjectAccess` (role matrix
  + token project restriction + token scope: `view`→read, `run`/`cancel_*`/`execute_manual`→run,
  everything else→write). Entity keys → project with `authz.ProjectKeyOf` / `ParseEntityKey`.
  Unknown or inaccessible project ⇒ 404, never 403.
- Non-project groups use `auth.RequireMethodScope` (GET→read, else write). Anything that
  must not be reachable with an API token uses `auth.RequireSession`.
- Error messages are English; codes/statuses follow the mock (`httpx.BadRequest` = 400
  `validation_failed` for simple field errors, `httpx.Unprocessable` = 422 for DSL/flow validation).
- JSON: required-nullable fields are pointers without `omitempty`; lists are never `null`
  (`httpx.NewList`, `NewPage`); times are rendered UTC (`auth.UTCPtr`, `.UTC()`).
- `UserRef` JOINs: `LEFT JOIN users` + `auth.NewUserRef(id, name, email)`.

## Auth notes

- CSRF: `httpx.CSRF` rejects every non-GET/HEAD/OPTIONS request without `X-QAtlas-CSRF: 1`
  unless it carries `Authorization: Bearer`. This includes login/invite-accept.
- `Authorization` present ⇒ only the token is considered (an invalid token is a 401, no cookie fallback).
- Admin endpoints and `POST/DELETE /me/tokens` are session-only; password change is session-only.
- Login: generic 401 `invalid_credentials`; 10 failures / 15 min per email+IP (50 per IP) ⇒ 429
  `rate_limited` (failures before the last success don't count). Set `QATLAS_TRUST_PROXY=true`
  only behind a proxy that overwrites `X-Real-IP` / `X-Forwarded-For`.
- Disabling a user revokes tokens, deletes sessions and voids open invite links.
- Passwords: at least `auth.MinPasswordLength` = 8 characters (`auth.CheckPasswordLength`:
  invite accept, `PATCH /me`; also `user create-admin`, `seed demo --password`). No maximum.
- Google: `/auth/google/start` redirects to Google's fixed authorization endpoint (no network
  call); OIDC discovery happens lazily on the first callback (not cached when it fails, so it
  is retried). State/nonce/PKCE verifier in a 10-minute `qatlas_oidc` cookie; rejections
  redirect to `/login?error=not_registered`, technical failures to `/login?error=google_failed`.
- Google configuration (`internal/auth/google_settings.go`, `/admin/settings/google-auth`
  GET/PUT/DELETE, admin + session only): non-empty `GOOGLE_CLIENT_ID` → env (`source: env`,
  writes 409 `env_override`); else `system_settings` key `google_auth` (value without the
  secret; `client_secret` sealed in `secret_enc`); else off. PUT parses Google's client JSON
  (`web` only; `installed` → 422 `client_json`), omitted `client_json` / `allowed_domains`
  keep the stored ones. Start, callback, `/auth/config` and the domain rule read the active
  config per request from a per-process cache that is dropped by the saving process and, in
  the others, on NOTIFY `qatlas_settings` payload `google_auth` (dispatched by the storage
  `Registry` listener via `OnNotify`; a static registry does not listen).
