# 13 — Implementation Guide (Phase 2–5)

Binding conventions for everyone implementing the backend, runner, MCP and deployment. The planning docs (02–08, 12) describe *what*; this file pins *how* so parallel work fits together.

## Source of truth
1. `api/openapi.yaml` — request/response shapes. JSON field names in Go DTOs must match exactly.
2. `web/src/mocks/handlers.ts` — **behavioural reference**. Every endpoint, validation rule, permission check and error code implemented by the mock must be reproduced by the Go backend (messages in **English**). If the mock and OpenAPI disagree, OpenAPI wins for shape, the mock wins for behaviour; note the discrepancy.
3. `web/src/lib/steps.ts` (action catalog, `validateSteps`, `summarizeStep`) and `web/src/lib/permissions.ts` (RBAC matrix) — port to Go 1:1 (`internal/dsl`, `internal/authz`).

## Ports & local services (dev)
| Service | Address |
|---|---|
| Postgres (compose `deploy/docker-compose.dev.yml`) | `127.0.0.1:55432`, db/user/pass `qatlas` |
| Test database | same server, db `qatlas_test` |
| API server | `:8090` |
| Vite dev server | `:5173` (proxies `/api` → `:8090` when `VITE_API_MODE=real`) |
| Demo target app (for runner tests & demo seed) | `:8099` |

5432 and 8080 are taken by other services on this host — do not use them.

## Repository layout
```
backend/                       Go module `github.com/kalfian/qatlas/backend` (go 1.27)
  cmd/qatlas/main.go           subcommands: server | worker | all | migrate up|down|status | user create-admin | seed demo | artifacts migrate|check | mcp-stdio | version
  internal/config              env config (QATLAS_*), validated at start
  internal/db                  pgx pool, goose migrations (embedded), tx helper, testutil (truncate)
  internal/httpx               JSON helpers, APIError, middleware (request id, slog, recover, auth, csrf), pagination
  internal/authz               RBAC (port of permissions.ts)
  internal/auth                argon2id, sessions, invites, Google OIDC, API tokens, Actor
  internal/users               /me, /admin/users
  internal/projects            projects, members, stats, assignable users
  internal/environments        environments + encrypted secrets
  internal/dsl                 step catalog, validation, summary, interpolation (port of steps.ts)
  internal/testcases           folders, tags, test cases, revisions, bulk
  internal/flows               flows
  internal/runs                run creation/snapshots, manual results, attachments, cancel/rerun, list/detail
  internal/artifacts           ArtifactStore (local FS, S3), GET /artifacts/{id} with Range
  internal/storage             Admin → Storage settings (DB, encrypted secret), Registry hot swap, storage migration job
  internal/events              LISTEN/NOTIFY bus + SSE handler
  internal/worker              River jobs, runner supervisor (NDJSON), retention job
  internal/mcp                 MCP server (official go-sdk), tools call the same services
  internal/web                 serve web/dist (SPA fallback) when QATLAS_WEB_DIR set
  migrations/                  goose SQL files 0001_*.sql …
runner/                        Node 22 + TypeScript + official `playwright` (library mode)
demo-target/                   tiny static "Tokoku" shop used as test target (served on :8099)
deploy/                        Dockerfiles, docker-compose.yml (+ .dev.yml), systemd units, install.sh
```

## Go conventions
- Libraries: `go-chi/chi/v5`, `jackc/pgx/v5` (pgxpool; hand-written SQL, no ORM), `pressly/goose/v3` (embedded migrations), `riverqueue/river` + `riverdriver/riverpgxv5`, `google/uuid` (v7 IDs), `golang.org/x/crypto/argon2`, `coreos/go-oidc/v3` + `golang.org/x/oauth2`, `modelcontextprotocol/go-sdk`, `log/slog`. Prefer stdlib otherwise. Pin versions in go.mod.
- Each package exposes `New(deps…)` and `Routes(r chi.Router)`. Business logic lives in a service struct (methods take `ctx`, `auth.Actor`, input) so REST handlers **and MCP tools call the same code**.
- `auth.Actor{User, TokenID *uuid, Scopes}` is put in the request context by middleware; `authz.Can(role, action, systemRole)` + token scope check (`read` for GET, `write` for mutations, `run` for creating/cancelling runs & manual results).
- Errors: return `*httpx.APIError{Status, Code, Message, Details []FieldError}`; `httpx.WriteError` renders `{"error":{...}}`. Codes as in the mock: `unauthenticated` 401, `invalid_credentials` 401, `forbidden` 403, `not_registered` 403, `not_found` 404, `conflict` 409, `revision_conflict` 409, `in_use` 409, `validation_failed` 400/422, `expired` 410, `too_large` 413, `rate_limited` 429.
- Project-scoped resources resolve project from the key prefix (`SHOP-T12` → `SHOP`); unknown or inaccessible project → 404 (don't leak existence).
- Keys: per-project counters (`projects.seq_case/seq_flow/seq_run`) incremented with `UPDATE … RETURNING` inside the creating transaction.
- Times: `timestamptz`, JSON RFC3339 UTC. JSON `null` vs omitted exactly as OpenAPI `required`.
- Audit: `audit_logs` row for the actions listed in docs/05.
- Tests: `go test ./...`; integration tests use `QATLAS_TEST_DATABASE_URL` (skip with a clear message if unset), migrate once, `TRUNCATE` between tests. Run `go vet` and `gofmt`.

## Auth details
- Cookie `qatlas_session` (HttpOnly, SameSite=Lax, Secure when base URL is https), token hashed (SHA-256) in `sessions`; sliding 7 days idle / 30 days max.
- **CSRF:** mutating requests authenticated by cookie must carry header `X-QAtlas-CSRF: 1` (custom header ⇒ cross-site forms/fetch can't send it without CORS). The web client always sends it. Bearer-token requests are exempt.
- Passwords argon2id (`m=64MiB,t=3,p=2`, encoded PHC string). Login rate limit: 10 failures / 15 min per email+IP → 429.
- Google: configured in Admin → Google sign-in (`/admin/settings/google-auth`, `system_settings` key `google_auth`, secret sealed with the master key); `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in the environment override it. Read per request, cache dropped on NOTIFY `qatlas_settings` `google_auth`. `GET /api/v1/auth/config` → `{ "google_enabled": bool, "mode": "real" }` (the web uses it to show the button). Callback rules per docs/05.
- API tokens: `qat_<8 hex prefix>_<32 hex secret>`, SHA-256 stored, `Authorization: Bearer`.
- Bootstrap: `qatlas user create-admin --email … --name … --password …` (password from flag or prompt/env `QATLAS_ADMIN_PASSWORD`).

## Secrets
`QATLAS_MASTER_KEY` = base64 of 32 random bytes. Secret values AES-256-GCM encrypted (nonce‖ciphertext) in `environment_secrets.value_enc`. Never returned by the API; decrypted only in the worker when building `run.start`.

## Runs, worker and runner protocol
- `POST /projects/{key}/runs` snapshots the target (test case(s) with steps, flow options, env name + variables, secret **names**) into `runs.snapshot`, creates `run_cases`/`run_steps` (`summary` = `dsl.Summarize` of the step interpolated with env vars and `••••` for secrets), and in the same transaction enqueues a River job `run_execute{run_id}` — unless the first case is manual (status `awaiting_manual`, no job).
- Worker job: loads run, takes the next **segment** = consecutive automated cases from `resume_position` (or 1) until the next manual case. Decrypts secrets, sends `run.start` to a runner slot, streams events into the DB, masks every resolved secret value in strings before writing, uploads artifacts from `artifact_dir` to the ArtifactStore, `pg_notify('qatlas_run_events', '{"run_key":"…","type":"…"}')`. Reaching a manual case → `awaiting_manual` + `resume_position`; `complete-manual` enqueues the next `run_execute`.
- Cancel: `cancel_requested=true`; worker sends `run.cancel`, kills the context after 5 s grace; final status `cancelled`.
- Runner process: `node runner/dist/main.js` (configurable `QATLAS_RUNNER_CMD`), long-lived, supervised (restart on crash; in-flight runs → `error`). `WORKER_CONCURRENCY` slots (default 2).

NDJSON over stdin/stdout (one JSON object per line; runner logs go to stderr):

```jsonc
// Go → runner
{"type":"run.start","run_id":"…","artifact_dir":"/var/lib/qatlas/tmp/<run_id>",
 "options":{"browser":"chromium","headless":true,"viewport":{"width":1280,"height":720},
            "screenshot":"on_failure","video":"off","step_timeout_ms":10000,"retries":0},
 "shared_session":false,"stop_on_failure":true,
 "env":{"BASE_URL":"…"},"secrets":{"QA_PASSWORD":"…"},"vars":{"email":"…"},
 "cases":[{"case_id":"<run_case id>","continue_on_failure":false,"vars":{…},
           "steps":[{"step_id":"<run_step id>","action":"goto","url":"{{env.BASE_URL}}/login","timeout_ms":null,
                     "continue_on_failure":false,"enabled":true,"screenshot":false, "…other DSL params"}]}]}
{"type":"run.cancel","run_id":"…"}
// runner → Go
{"type":"ready","playwright":"1.x"}
{"type":"case.started","run_id":"…","case_id":"…"}
{"type":"step.started","run_id":"…","case_id":"…","step_id":"…"}
{"type":"step.finished","run_id":"…","case_id":"…","step_id":"…","status":"passed|failed|error|skipped",
 "duration_ms":123,"error":null,"screenshot":"/abs/path.png|null","details":{"expected":"…","actual":"…"}|null}
{"type":"case.finished","run_id":"…","case_id":"…","status":"passed|failed|error|skipped","video":"/abs/path.webm|null"}
{"type":"run.finished","run_id":"…","status":"passed|failed|error|cancelled"}
{"type":"runner.error","run_id":"…|null","message":"…"}
```
Runner semantics: interpolation `{{env.X}}`, `{{secret.X}}`, `{{vars.x}}`, `{{fn.uuid|now|random_email|random_int}}`, `{{fn.totp <ref> [digits] [period] [algorithm]}}` (see docs/04); `vars` precedence env < run vars < case vars < runtime (`save`, `extract_text`, `set_variable`), runtime vars carry across cases only when `shared_session`. Selector mapping per docs/04. Failed step → rest `skipped` unless `continue_on_failure`. Flow-level: a failed case with `stop_on_failure` and not `continue_on_failure` → remaining cases emitted as `case.finished` `skipped`. Retries re-run a failed case (fresh context unless shared). Screenshot `every_step` / `on_failure` / per-step `screenshot:true`; HTTP steps never screenshot. Video `always` / `on_failure` (record, delete if passed); shared session ⇒ one video for the segment (attached to the first case). `details` for assertions = `{expected, actual}`, for `http_request` = `{request:{method,url}, response:{status,time_ms,body}}` (body truncated to 8 KB).

### Runner behaviour the worker must handle (from `runner/README.md`)
- `case.finished` may arrive **twice** for the first case of a shared-session segment (second one carries the video path) → treat as idempotent upsert.
- Skipped steps get only `step.finished` (no `step.started`); cases skipped by stop_on_failure/cancel get only `case.finished`.
- Retries repeat `case.started` and the step events for the same `step_id`s; only the final `case.finished` counts.
- Unknown `{{env|secret|vars.X}}` fails the step. Secrets are already masked `••••` in runner events (worker still masks as a second layer).
- The runner does not enforce the overall run timeout — the worker does.

## Events / SSE
`GET /api/v1/runs/{runKey}/events` (text/event-stream). Server LISTENs on `qatlas_run_events`, fans out per run key; each event `data: {"type":…,"run_key":…}`; heartbeat comment every 15 s. Clients re-fetch `GET /runs/{key}` on each event (the web keeps polling as fallback).

## Web (real mode)
- `VITE_API_MODE=real` → no MSW; client sends `X-QAtlas-CSRF: 1`; Google button uses `/auth/config`; `useRunProgress` subscribes to SSE and invalidates the run query.
- `qatlas server` serves `web/dist` when `QATLAS_WEB_DIR` is set (SPA fallback to index.html, `/api` excluded).

## Definition of done (per component)
Builds, `go vet` + `gofmt` clean, unit/integration tests pass, behaviour parity with the mock for the endpoints owned, and docs/10-roadmap.md checklist updated by the coordinator.
