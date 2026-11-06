# @qatlas/runner

Executes Step DSL test cases (docs/04) with the official `playwright` library (**1.64.1**, library
mode) and talks to the Go worker over NDJSON (docs/13 "Runs, worker and runner protocol").

```bash
corepack pnpm --filter @qatlas/runner build      # tsc → dist/
node runner/dist/main.js                         # long-lived; NDJSON on stdin/stdout, logs on stderr
corepack pnpm --filter @qatlas/runner test       # build + integration tests (spawns runner + demo-target)
corepack pnpm --filter @qatlas/runner typecheck  # tsc --noEmit
corepack pnpm --filter @qatlas/runner lint       # eslint (src, scripts, tests)
node runner/scripts/smoke.mjs [case] [--video] [--every-step] [--headed] [--list]
```

`scripts/smoke.mjs` starts `demo-target` on a free port (or uses `BASE_URL` if set), spawns the
built runner, sends one `run.start` built from `scripts/shop-cases.mjs` (the SHOP cases of
`web/src/mocks/seed.ts` in wire format) and prints every event — a quick reference for the Go
worker author. Browsers must be installed for Playwright 1.64.1 (`chromium` + headless shell,
`webkit`; firefox is optional — missing firefox yields a clean `error` + `runner.error`).

Env: `QATLAS_RUNNER_LOG_LEVEL=debug|info|warn|error` (stderr), `PLAYWRIGHT_BROWSERS_PATH` (standard).

## Process model

- One process, many concurrent runs (each `run.start` is its own async task, keyed by `run_id`).
- One shared `Browser` per `(browser type, headless)` pair, launched lazily on first UI step and
  re-used across runs; a disconnected browser is forgotten and relaunched on next use.
- A fresh `BrowserContext` (+ one `Page`) per case — or one per segment when `shared_session` and
  the segment has 2+ cases. A context is only created when the case/segment has an enabled UI step;
  HTTP-only cases use a standalone `request.newContext()` and never launch a browser.
- The context is created when the case's **first** step runs (even if that step is HTTP), so HTTP
  steps in a mixed case go through `context.request` and share cookies with the page.
- **Device emulation** (docs/14): with `options.device` the context gets `viewport`,
  `deviceScaleFactor`, `hasTouch`, `isMobile` (never on Firefox, which Playwright does not support
  there) and the `userAgent` of `devices[device.playwright]` from the installed Playwright (no
  descriptor → no UA override, no error); the video size is the viewport (`src/session.ts`
  `contextOptions`). Without `device` the context is exactly the plain `viewport` one. Pages without
  `<meta name="viewport" content="width=device-width">` lay out at 980 px under `isMobile` (Chromium).
- Shutdown: **stdin EOF** → stop accepting, let in-flight runs finish, close browsers, exit 0.
  **SIGTERM/SIGINT** or a broken stdout (EPIPE) → cancel in-flight runs (normal cancel events),
  close browsers, exit 0 (second signal forces exit). `uncaughtException` → `runner.error`, exit 1.

## Protocol notes (all events are exactly the docs/13 shapes)

- `ready` is the first line; `playwright` is the installed library version.
- Invalid `run.start` (missing ids, unknown action, **any `manual` step**, unsupported browser) →
  `runner.error{run_id, message}` followed by `run.finished{status:"error"}`; nothing else for that run.
  Unparseable line / unknown `type` → `runner.error{run_id:null}`; the process keeps running.
- Step events: `step.started` then `step.finished`. Steps that do not execute (disabled, after a
  failure, after cancel) get only a `step.finished{status:"skipped", duration_ms:0}`.
- Cases skipped by `stop_on_failure` or cancellation get only `case.finished{status:"skipped"}`
  (no `case.started`, no step events) — the worker marks their steps skipped.
- **Retries** (`options.retries`, clamped 0–5): a `failed` case is re-run; each attempt emits a new
  `case.started` and a full set of step events for the same `step_id`s (later events overwrite
  earlier ones); exactly one `case.finished` with the final result. `error` cases are not retried.
  Non-shared retries get a fresh context and fresh runtime vars; shared retries reuse both.
- **Shared-session video**: the segment's single video can only be finalised after its context
  closes (after the last case), and `on_failure` can only be decided then. So the first case's
  `case.finished` is emitted with `video:null` at its normal time and **emitted a second time** —
  same status, with the `video` path — right before `run.finished`. Treat `case.finished` as
  idempotent. This is the only repeated event; it only happens for `shared_session` with 2+ cases
  and a kept video. (A 1-case "shared" segment behaves like an isolated case.)
- `details`: assertions → `{expected, actual}` (strings, on pass and fail); `http_request` →
  `{request:{method,url}, response:{status,time_ms,body}}` with `body` = parsed JSON when the body
  is JSON and ≤ 8 KB, else the text truncated to 8 KB (+ `…[truncated]`); on a network failure
  `response` is `null`. A polling `http_request` (`poll_timeout_ms > 0`) adds `attempts` (number of
  requests sent) and reports the **last** response. A failed `expect_no_horizontal_scroll` adds
  `offenders` (≤ 5 strings). All other actions → `null`.
- Paths in `screenshot` / `video` are absolute, under `artifact_dir/<case_id>/`:
  `step-NN-<step_id>[-<name>][-attemptN].png`, `video.webm`.
- Secret values are masked (`••••`) in every emitted event as defence in depth (values ≥ 3 chars);
  the worker still masks before writing. Screenshots/videos cannot be masked.

## Semantics

- Interpolation of all step params except `description`/`expected`, deep (headers, query, body,
  save…): `{{env.X}}`, `{{secret.X}}`, `{{vars.x}}`, `{{fn.uuid}}`, `{{fn.now}}` (ISO),
  `{{fn.random_email}}`, `{{fn.random_int}}` (0–99) / `{{fn.random_int 1 100}}` (inclusive),
  `{{fn.totp <ref> [digits=6] [period=30] [algorithm=SHA1|SHA256|SHA512]}}` (RFC 6238; `<ref>` =
  `secret.X` / `env.X` / `vars.x` / literal base32 seed; `src/totp.ts`). Before interpolating a step
  that uses `fn.totp`, the runner waits for the next period if < 3 s remain. The generated code and
  its seed are added to the run's masker, so they show as `••••` in every later event; seeds are never
  echoed in error messages.
  `vars` = env < run `vars` < case `vars` < runtime (`save`, `extract_text`, `set_variable`).
  Runtime vars carry across cases only with `shared_session`. **An unknown key in a known
  namespace fails the step** (`Unknown variable {{vars.x}} …`) instead of sending the literal.
- Failure → remaining steps `skipped` unless the step has `continue_on_failure`. Case status:
  `error` > `failed` > `passed`; all skipped → `skipped`; a case interrupted by cancel → `skipped`
  (as the mock). Run status: `cancelled` > `error` > `failed` > `passed`.
- `stop_on_failure` (default `true` when omitted): a `failed`/`error` case without the case-level
  `continue_on_failure` skips all remaining cases.
- Screenshots: UI steps only (HTTP and `wait`/`set_variable` never), taken after the step when
  `every_step`, on `failed`/`error` with `on_failure`, or when the step has `screenshot:true`.
  The `screenshot` action's own file is the step's screenshot.
- Video: `always` keeps it; `on_failure` records and deletes it when the case (segment) passed;
  dropped on cancel; earlier retry attempts' videos are deleted.
- Classification: assertion mismatch, Playwright timeout, strict-mode violation, navigation/network
  error of the target, invalid step params → `failed`. Browser launch / context creation failure,
  page crash, runner bugs → `error` plus a `runner.error{run_id}`.
- Cancel (`run.cancel`): aborts an `AbortController` and closes the run's contexts / request
  contexts, which makes any in-flight Playwright call reject immediately; polls and `wait` sleeps
  observe the signal. The current step and the rest → `skipped`, remaining cases →
  `case.finished skipped`, then `run.finished{status:"cancelled"}` (well under 1 s in tests).

## Selectors

| DSL | Playwright |
|---|---|
| `role=button[name='Masuk']` | `getByRole('button', { name: 'Masuk' })` (`[name='X' s]` → `exact: true`) |
| `label=Email` | `getByLabel('Email')` |
| `placeholder=Cari` | `getByPlaceholder('Cari')` |
| `testid=submit` | `getByTestId('submit')` |
| `text=Selamat datang` | `getByText('Selamat datang')` |
| anything else (`#id`, `.btn`, `xpath=…`, `//…`) | `page.locator(…)` |

For `label=`/`placeholder=`/`text=`, a value wrapped in double quotes (`text="Exact"`) means
`exact: true`. Messages describe locators in this code form, e.g.
`Expected text of getByTestId('grand-total') to equal "Rp 81.000", received "Rp 90.000"`.

## Assertions: own polling, not `@playwright/test`'s `expect`

Checked during implementation: `expect` from `playwright/test` **does** work in library mode with
1.64.1 (`expect(locator).toHaveText()` outside a test file). It is **not** used, because:

1. its failure messages are multi-line, ANSI-coloured and English-templated, while the protocol wants
   one clean human message plus structured `details {expected, actual}`;
2. it cannot be aborted by `run.cancel` (we need to stop within milliseconds, not at the timeout);
3. it pulls in test-runner internals the runner does not otherwise need.

So assertions poll on their own (`src/poll.ts`): probe → check, at Playwright's expect intervals
(0, 100, 250, 500, then every 1000 ms) until `timeout_ms ?? options.step_timeout_ms`, abortable.
Probes never block: `allTextContents()`, `evaluateAll()`, `count()`, `page.url()`, `page.title()`.

- `expect_text` / `expect_value`: **strict** — exactly one element must match (textContent with
  whitespace normalised like `toHaveText`; `.value` for inputs). `match` defaults to `contains`
  (the web editor's default).
- `expect_visible` / `expect_hidden` / `wait_for`: **non-strict** — visible = at least one match
  visible; hidden = no match visible (or none exist). `wait_for attached` = at least one attached.
- `expect_count` ops `eq`/`gte`/`lte`. `expect_url` `equals` with a relative value (`/akun`)
  compares against the URL resolved on the current page.
- HTTP assertions check the last `http_request` response of the case immediately (no polling):
  `expect_status` (`value` or `in`), `expect_json` (`eq`/`neq`/`contains`/`exists`/`gt`/`lt`/
  `matches`; UI string values compare loosely: `"true"` eq `true`, `"10000"` eq `10000`),
  `expect_header` (case-insensitive name), `expect_response_time`.
- JSONPath subset: `$`, `.key`, `['key']`, `[n]`, `[-n]` (e.g. `$.data[0].id`); no wildcards/filters.
- `http_request` extras (docs/04 "Email testing"): `save_regex {name: pattern}` (JS regex or
  `/pattern/flags`; saves group 1, else the whole match) on the body after `regex_decode`
  (`none` | `quoted_printable` | `html` | `auto`; `src/decode.ts` — any decoding searches a JSON body
  by its unescaped string values; `auto` only un-QPs text that looks quoted-printable).
  `poll_timeout_ms` (≤ 120000) / `poll_interval_ms` (≥ 200, default 1000) / `poll_until` (JSONPath,
  non-null and not `[]`): re-send until 2xx + `poll_until` + every `save`/`save_regex` resolves;
  network errors count as "not yet"; a malformed JSONPath/regex fails at once. Timeout message:
  `Polling GET <url> timed out after N ms (K attempts); still missing: …`. Each request's own timeout
  is `min(step timeout, time left)` (≥ 1 s).
- Interactions (`click`, `fill`, …) use Playwright auto-wait with the step timeout and are strict.
- `set_viewport` `width` 320–3840 / `height` 320–2160 (integers; numeric strings accepted) →
  `page.setViewportSize`; size only (isMobile/UA/touch are fixed per context). `details` null.
- `expect_no_horizontal_scroll` (`src/overflow.ts`): polls until `scrollWidth ≤ clientWidth +
  tolerance_px` (0–50, default 0) of the container — `selector` (**strict**, one element) or
  `document.scrollingElement`. `details {expected: "content width ≤ {clientWidth}px" (+ " (+Npx
  tolerance)" when N > 0), actual: "content width {scrollWidth}px"}`; on failure also `offenders`:
  up to 5 visible descendants whose right edge passes the visible right edge (+ tolerance), widest
  first, `"tag#id.c1.c2.c3… (right edge Npx)"` (px from the container's left edge). Elements with
  `visibility:hidden` or clipped by an inner `overflow-x` container are not offenders. Chromium's
  `isMobile` shrink-to-fit reports an overflowing document's `scrollWidth` about 1 px wider.
- `only_on` is resolved by the server (non-matching steps arrive `enabled:false`); the runner
  ignores the key.

## Layout

```
src/main.ts         stdin/stdout loop, run registry, shutdown
src/run.ts          RunExecution: validation, cases/segments, retries, stop_on_failure, video, cancel
src/actions.ts      every catalog action + post-step screenshots
src/session.ts      BrowserContext/Page (device emulation) or standalone APIRequestContext of a case/segment
src/overflow.ts     in-page scan for expect_no_horizontal_scroll (widths + offenders)
src/browsers.ts     shared Browser pool
src/selectors.ts    DSL selector → locator (+ description)
src/interpolate.ts  {{…}} interpolation and fn.* (fn.totp → src/totp.ts)
src/decode.ts       regex_decode (quoted-printable, HTML entities) for http_request save_regex
src/poll.ts, match.ts, jsonpath.ts, errors.ts, emitter.ts (NDJSON + masking), log.ts (stderr)
scripts/            smoke.mjs, shop-cases.mjs (seed SHOP cases in wire format)
test/               node:test integration tests (spawn dist/main.js + demo-target / a local HTTP
                    server for polling + save_regex; responsive.test.mjs: devices, set_viewport, overflow)
                    and unit.test.mjs (TOTP RFC 6238 vectors, decoding)
```

## Known limitations

- No `run_timeout_ms` inside the runner (the worker enforces it with `run.cancel` + kill).
- One page per context: popups/new tabs, iframes and file uploads are not supported (docs/04 v1).
- Browser dialogs are auto-dismissed (Playwright default).
- `headless:false` needs a display; a headed browser is a separate pool entry.
- Screenshots/videos may contain secret values typed into visible fields.
