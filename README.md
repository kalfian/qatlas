# QAtlas

Self-hosted test management and execution. Write test cases per project as structured steps,
run them on the server with Playwright, and read one report per run with screenshots, video,
and expected vs actual. Tests that need a person run as manual test cases in the same report,
and AI agents can do the whole loop through MCP.

![Writing a test case in the step editor, running it, and opening the report](docs/manual/video/create-and-run-test-case.gif)

**User manual:** [English](docs/manual/README.md) · [Bahasa Indonesia](docs/manual/README.id.md)

## End-to-end demo

One take through the whole product (1 min 59 s, no sound): sign in → environment variables and
secrets → write a test case in the step editor → run it with screenshots and video → read the
report → run a flow that pauses for a manual check, work through it, and watch the flow finish on
its own → run an email-verification test (sign up, poll Mailpit until the mail arrives, open the
link) → run history and dashboard → Admin → Storage with artifacts in an S3 bucket (Garage) → API
token and MCP setup for AI agents → switch the UI to Bahasa Indonesia and back.

[![Watch the end-to-end demo](docs/manual/video/end-to-end-poster.png)](docs/manual/video/end-to-end.mp4)

[▶ end-to-end.mp4](docs/manual/video/end-to-end.mp4) (1280×800, 2.1 MB) — recorded on a real
instance (Go backend, worker, Playwright runner) against the bundled demo shop.

## Features

- **Test cases as steps, not code.** A step editor with an action palette (`goto`, `click`,
  `fill`, `expect_text`, `http_request`, …), Playwright-style selectors (`role=`, `label=`,
  `testid=`), variables and secrets, JSON mode with schema validation, keyboard shortcuts, and a
  revision history.
- **UI and API in one test.** HTTP steps and assertions (`expect_status`, `expect_json`, …) run
  next to browser steps; a browser starts only when a test needs one.
- **Flows.** Chain test cases into one run, in one shared browser session or isolated, with
  stop-on-failure.
- **Asynchronous runs on real browsers.** Chromium, Firefox, or WebKit, any viewport,
  screenshots (off / on failure / every step), video (off / on failure / always), retries,
  live progress, cancel, re-run failed.
- **Responsive testing.** Run a test case or flow on up to six devices at once (desktop,
  iPad, iPhone, Pixel, … with real mobile emulation: touch, pixel ratio, user agent) and read the
  result as a case × device matrix. Steps can be limited to mobile/tablet/desktop (`only_on`),
  resize mid-test (`set_viewport`) and catch layouts that overflow sideways
  (`expect_no_horizontal_scroll`). See [docs/14](docs/14-responsive-testing.md).
- **Reports that explain the failure.** Expected vs actual, the Playwright error, a screenshot
  of the failing step, video, and HTTP request/response details.
- **Manual testing when it's needed.** Manual test cases with instructions and expected results;
  testers mark steps Passed / Failed / Blocked / Skipped with notes and attachments. Flows can mix
  automated and manual test cases and continue automatically.
- **Teams.** Admin-managed users (invite links, optional Google sign-in for registered emails),
  per-project roles (maintainer, editor, viewer), environments with write-only encrypted
  secrets.
- **AI and CI.** An MCP server with 19 tools (create → validate → run → wait → report, including
  failed-step screenshots as images), scoped API tokens, and a JUnit XML export for CI.
- **English and Bahasa Indonesia** UI, light and dark theme, usable on a phone.

## Screenshots

| | |
|---|---|
| ![Step editor with the side panel on a selector step](docs/manual/img/step-editor-panel.png) | ![Failed run: expected vs actual with a screenshot](docs/manual/img/run-failed-report.png) |
| Step editor | Failed run report |
| ![Executing a manual test case](docs/manual/img/manual-execution.png) | ![Project dashboard in dark theme](docs/manual/img/dark-dashboard.png) |
| Manual execution | Dashboard (dark theme) |

More in the [user manual](docs/manual/README.md).

## Architecture

```mermaid
flowchart LR
    user[Browser<br/>React SPA] -->|REST + SSE| server
    ai[AI client<br/>Claude Code] -->|MCP over HTTP<br/>Bearer token| server
    ci[CI job] -->|REST<br/>Bearer token| server

    subgraph qatlas[qatlas binary: server / worker / all]
        server[server<br/>API, SPA, /mcp]
        worker[worker<br/>River jobs]
    end

    server <--> pg[(PostgreSQL<br/>data, job queue,<br/>LISTEN/NOTIFY)]
    worker <--> pg
    worker <-->|NDJSON<br/>stdin/stdout| runner[Node runner<br/>Playwright]
    runner -->|browser + HTTP| app[App under test]
    worker --> artifacts[(Artifacts<br/>screenshots, video)]
    server --> artifacts
```

| Part | Stack |
|---|---|
| Backend | Go 1.27, one binary with `server`, `worker`, `all`, `migrate`, `user create-admin`, `seed demo`, `mcp-stdio`; chi, pgx, goose |
| Queue and events | [River](https://riverqueue.com) on PostgreSQL; LISTEN/NOTIFY → Server-Sent Events for live progress |
| Runner | Node 22 + official Playwright 1.64, driven by the worker over NDJSON |
| Frontend | React 19, Vite, TypeScript, TanStack Router/Query, Tailwind v4, Radix; i18next (en, id) |
| MCP | Official Go SDK, Streamable HTTP at `/mcp`, stateless |
| Storage | PostgreSQL 16; artifacts on the local filesystem with daily retention |
| Contract | [`api/openapi.yaml`](api/openapi.yaml) is the source of truth for frontend and backend |

## Quick start

### a) Try it locally (demo)

Runs the real stack (backend, worker, Playwright runner) plus **Tokoku**, a small fake shop to
test against, on one machine without Docker images or systemd. Needs Docker (for the dev
Postgres), Go 1.27, Node 22 with corepack, and Playwright's Chromium.

```bash
corepack enable && pnpm install
corepack pnpm --filter @qatlas/runner exec playwright install --with-deps chromium
make dev-db                       # Postgres on 127.0.0.1:55432 (container qatlas-dev-postgres)
scripts/demo-server.sh start      # builds, migrates, seeds, starts → http://<your-ip>:8090
```

Sign in as `rina@tokoku.id` / `password123` (admin). `dimas@tokoku.id` is an editor and
`sari@tokoku.id` a viewer of the SHOP project, same password. The seed includes test cases,
flows, environments, and a few real runs: one passed, one failed on the shop's deliberate
voucher bug, one waiting for Rina's manual check under **My tasks**.

The script also downloads (once, pinned and checksum-verified) and starts
[Mailpit](https://mailpit.axllent.org), a local email catcher: SMTP on `127.0.0.1:1025`, inbox UI
and API on `http://127.0.0.1:8025`. The shop's sign-up sends its verification email there, and
three SHOP cases show the patterns: **SHOP-T20** logs in with TOTP 2FA via
`{{fn.totp secret.QA_TOTP_SEED}}`, **SHOP-T21** signs up, polls Mailpit until the email arrives,
extracts the link with `save_regex` and opens it, **SHOP-T22** does the same with the 6-digit code.
The shop is also a small REST API: **SHOP-T23…T27** (flow **SHOP-F4 API regression**) show API
testing — token chaining, a CRUD lifecycle, 422/401 negative tests, headers and response time — and
the **PAY** project tests a payment API, polling a refund until it has settled
([manual → API testing](docs/manual/README.md#api-testing)).
The TOTP seed is a public demo-only value (see [demo-target/README.md](demo-target/README.md)).

`scripts/demo-server.sh status | stop | reset` (reset deletes the demo database and data).
Logs are in `~/.local/state/qatlas-demo/`; generated secrets in `~/.config/qatlas/demo.env`.

### b) Docker Compose

```bash
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
# set POSTGRES_PASSWORD (openssl rand -hex 24), QATLAS_MASTER_KEY (openssl rand -base64 32),
# QATLAS_BASE_URL — and keep QATLAS_MASTER_KEY in a password manager
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec server \
  qatlas user create-admin --email you@example.com --name "Your Name"
```

Add `--profile demo` to also start the demo shop and Mailpit, then seed it with `qatlas seed demo
--target-url http://demo-target:8099 --mailpit-url http://mailpit:8025` (see
[deploy/README.md](deploy/README.md#a-docker-compose)).

### c) Binary + systemd

`make release` builds a tarball; `deploy/install.sh` installs it with systemd units, migrations,
browsers, and rollback. Full guide, including Proxmox LXC preparation, reverse proxy (SSE),
backups, and upgrades: [deploy/README.md](deploy/README.md).

## Development

Node ≥ 22 and pnpm 10 (via corepack), Go 1.27, Docker for the dev database.

```bash
corepack enable
pnpm install
pnpm dev                          # http://localhost:5173, frontend only on an in-browser mock API
```

**Mock mode** (default) needs no backend: MSW serves the API from `localStorage`, and a run
simulator fakes runs. Log in as `rina@tokoku.id` / `password123`. The **Mock** button (bottom
left) switches user, changes the simulation speed, and resets the demo data.

**Real mode** against the Go backend:

```bash
make dev-db                                    # Postgres on 127.0.0.1:55432
cd backend
cp .env.example .env                           # QATLAS_DATABASE_URL, QATLAS_MASTER_KEY
set -a; . ./.env; set +a
go run ./cmd/qatlas migrate up
go run ./cmd/qatlas seed demo --admin-token adm_stg_8f3a   # or: user create-admin
corepack pnpm --filter @qatlas/runner build    # the worker starts runner/dist/main.js
node ../demo-target/server.mjs &               # optional: the demo shop on :8099
go run ./cmd/qatlas all                        # API + worker on :8090
# in another shell, from the repository root:
VITE_API_MODE=real pnpm dev                    # proxies /api to QATLAS_API_URL (default http://127.0.0.1:8090)
```

More in [backend/README.md](backend/README.md).

| Command | Does |
|---|---|
| `pnpm dev` | Vite dev server (HMR) |
| `pnpm build` / `pnpm lint` / `pnpm typecheck` | Production build of `web/`, ESLint, TypeScript |
| `pnpm test` | Web unit tests (Vitest) |
| `pnpm e2e` | Playwright journeys against the mock build |
| `pnpm api:types` | Regenerate `web/src/api/schema.d.ts` from `api/openapi.yaml` |
| `make test` | `go vet` + `go test`, web unit tests, runner integration tests |
| `make build` | Real-mode SPA (`dist/web`), runner, and `dist/qatlas` |
| `scripts/e2e-real.sh` | The same Playwright journeys against the full real stack (own database `qatlas_e2e`, ports 8090/8099/5320; stop the demo server first or set `API_PORT`) |

Backend integration tests need `QATLAS_TEST_DATABASE_URL` and skip without it
([backend/README.md](backend/README.md#test)).

## MCP quick setup

Create a token under **API tokens & MCP** (scopes `read`, `write`, `run`), then:

```bash
claude mcp add --transport http qatlas https://qatlas.example.com/mcp \
  --header "Authorization: Bearer qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Ask Claude something like *"Create a login test case for project SHOP, run it on staging, and
summarize the result."* Tools, limits, and the stdio proxy: [docs/07-mcp.md](docs/07-mcp.md) and
the [manual](docs/manual/README.md#13-api-tokens-and-mcp-for-ai).

## Project status

Phases 1–4 are done: the frontend, the Go backend, the runner and reporting, and MCP with API
tokens. Phase 5 (hardening and extras such as CI integration, schedules, notifications) is in
progress. The live checklist is in [docs/10-roadmap.md](docs/10-roadmap.md#checklist-progres).
Not yet available: scheduled runs, email delivery (invites and password resets are links an
admin shares), and the `inspect_page` MCP tool. Artifacts can live on local disk or in an
S3-compatible bucket such as Garage ([docs/12](docs/12-deployment.md#artifact-storage-local-vs-s3-garage)).

## Documentation

| Document | For |
|---|---|
| [User manual](docs/manual/README.md) ([ID](docs/manual/README.id.md)) | Using QAtlas, with screenshots and videos |
| [deploy/README.md](deploy/README.md) | Installing and operating (Docker Compose, systemd, LXC, TLS, backups) |
| [docs/ci/README.md](docs/ci/README.md) | Running QAtlas from CI with JUnit output |
| [docs/07-mcp.md](docs/07-mcp.md) | MCP tools for AI agents |
| [docs/04-test-definition.md](docs/04-test-definition.md) | The step format (DSL), selectors, variables, flows |
| [api/openapi.yaml](api/openapi.yaml) | REST API contract |
| [backend/README.md](backend/README.md) | Backend layout and conventions |
| [docs/README.md](docs/README.md) | Design and planning documents (mostly in Bahasa Indonesia) |
| [docs/design/ui-direction.md](docs/design/ui-direction.md) | UI design direction and tokens |

## License

No license has been chosen yet. Until one is added, the code is not licensed for reuse.
