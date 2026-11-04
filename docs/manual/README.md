# QAtlas user manual

QAtlas keeps your test cases per project, runs them with Playwright on the server, and stores
the results (screenshots, video, expected vs actual) in one report. Scenarios that a script
can't check are run as **manual** test cases by a tester, in the same report. AI agents can do
all of this through the built-in MCP server.

This manual follows one demo project: **SHOP** (the "Tokoku" web store). Every screenshot comes
from a real instance: Go backend, worker, Playwright runner, and the demo shop.

> Bahasa Indonesia: [README.id.md](README.id.md)

![Writing a test case, running it, and opening the report](video/create-and-run-test-case.gif)

**Walkthrough videos** (MP4, 1280×800, no sound):

| Video | Shows | Length |
|---|---|---|
| [**End-to-end demo**](video/end-to-end.mp4) | The whole product in one take: sign in → environment → step editor → run → report → flow with a manual check → history & dashboard → API token / MCP → language switch | 1 min 40 s |
| [Create and run a test case](video/create-and-run-test-case.mp4) | Step editor and action palette → save → run with screenshots and video → report | 42 s |
| [Fix a failing test](video/fix-a-failing-test.mp4) | Failed run → expected vs actual and screenshot → fix the step → re-run passes | 28 s |
| [Manual execution](video/manual-execution.mp4) | A flow pauses at a manual test case → the tester works through it → the flow resumes | 25 s |

## Contents

1. [Concepts](#1-concepts)
2. [Getting started](#2-getting-started)
3. [Managing users (admin)](#3-managing-users-admin)
4. [Projects and members](#4-projects-and-members)
5. [Environments and secrets](#5-environments-and-secrets)
6. [Writing test cases](#6-writing-test-cases)
7. [Manual test cases](#7-manual-test-cases)
8. [Flows](#8-flows)
9. [Running tests](#9-running-tests)
10. [Reading reports](#10-reading-reports)
11. [Manual execution](#11-manual-execution)
12. [Run history and dashboard](#12-run-history-and-dashboard)
13. [API tokens and MCP for AI](#13-api-tokens-and-mcp-for-ai)
14. [CI](#14-ci)
15. [Troubleshooting and FAQ](#15-troubleshooting-and-faq)

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Project** | Holds test cases, flows, environments, runs, and members. Its short **key** (`SHOP`) prefixes everything: test case `SHOP-T12`, flow `SHOP-F1`, run `SHOP-R2`. |
| **Test case** | One scenario as an ordered list of **steps**. Each save creates a new **revision**; a run keeps a snapshot of the revision it ran. |
| **Step** | One action with its parameters, e.g. `goto` a URL, `fill` an input, `expect_text`, `http_request`. Steps are structured data, not code, so people and AI can edit them safely. |
| **Selector** | How a step finds an element. Prefer `role=`, `label=`, `testid=` over CSS (see [Selectors](#selectors)). |
| **Variables** | `{{env.NAME}}` from the environment, `{{secret.NAME}}` for secrets, `{{vars.name}}` for test case/flow variables and values saved during a run, `{{fn.uuid}}` and other helpers. |
| **Environment** | A named set of variables and secrets per target, such as `staging` and `production`. You pick one when you start a run. |
| **Secret** | An environment value that is write-only: nobody can read it back, and it is masked as `••••` in reports, logs, and MCP output. |
| **Flow** | An ordered list of test cases that runs as one run, optionally in one shared browser session. |
| **Run** | One execution of a test case or flow with options (browser, viewport, screenshots, video, retries). Runs execute asynchronously on the worker. |
| **Manual test case** | A test case with `execution: manual`. Its steps are instructions plus expected results that a tester marks Passed / Failed / Blocked / Skipped. |

**Roles.** Every user has a system role, and a role per project:

| Role | Can |
|---|---|
| **Admin** (system) | Create, invite, and disable users; see and create all projects. |
| **Member** (system) | Sign in and work in the projects they belong to. |
| **Maintainer** (project) | Everything an editor can, plus members, environments, run defaults, retention, and archiving. |
| **Editor** (project) | Create and edit test cases and flows, start runs, execute manual runs. |
| **Viewer** (project) | Read test cases, flows, runs, and reports. No edit, run, or settings buttons. |

An API token never has more access than its owner's role in each project.

**Run statuses** are always in English, in the UI and in the API/MCP output: Queued, Running,
Awaiting manual, Passed, Failed, Blocked, Error (an infrastructure problem, not a failed
assertion), Cancelled. Step results can also be Skipped.

## 2. Getting started

### Sign in

Open your QAtlas URL and sign in with the email and password your admin gave you (or the
password you set through your invite link). There is no self sign-up. If Google sign-in is
configured, **Continue with Google** works only for emails that already have an account.

![Sign-in page](img/login.png)

On the demo instance (`scripts/demo-server.sh start`) the accounts are `rina@tokoku.id`
(admin), `dimas@tokoku.id` (editor of SHOP) and `sari@tokoku.id` (viewer of SHOP), all with the
password `password123`.

### Find your way around

- **All projects** lists the projects you can access, with last run and 7-day pass rate.
- The project switcher at the top of the sidebar opens a project: **Dashboard**, **Test cases**,
  **Flows**, **Runs**, **Environments**, **Settings**.
- **My tasks** lists manual runs waiting for you.
- **Search** (`Ctrl K`, `⌘ K` on macOS) jumps to pages, projects, test cases, and flows; type a
  run key such as `SHOP-R12` to open that run.
- The sun/moon button switches between light and dark theme.

![Projects list](img/projects.png)

![The step editor in dark theme](img/dark-step-editor.png)

![Command palette searching for "checkout"](img/command-palette.png)

### Language

**Account → Language** switches the interface between **English** (default) and **Bahasa
Indonesia**. The choice is saved in your profile, so it follows you to every device. Status
labels (Passed, Failed, …) stay in English to match the MCP and API output.

![Language setting on the Account page](img/account-language.png)

![The step editor in Bahasa Indonesia](img/ui-indonesian-step-editor.png)

## 3. Managing users (admin)

**Admin · Users** lists everyone with their system role, status (Invited, Active, Disabled), and
last sign-in.

![Users page](img/admin-users.png)

**Create a user:** **Create user** → email and name → **Create user**. QAtlas shows an invite
link that is valid for 72 hours and can be used once. Send it over chat or email; the person
opens it, sets a password, and is signed in. (QAtlas does not send email itself yet.)

![Invite link dialog after creating a user](img/admin-invite-link.png)

The **⋯** menu on a user row has:

- **Regenerate invite link** for an invite that expired or got lost.
- **Create password reset link** when someone forgot their password (there is no self-service
  reset).
- **Change role** between Member and Admin.
- **Disable** / **Enable again**. Disabling signs the user out everywhere, revokes their API
  tokens, and voids open invite links.

You can't change your own role or status. A new user sees no projects until a maintainer adds
them to one.

## 4. Projects and members

**All projects → Create project** asks for a name and a key (`SHOP`). The key can't be changed
later because it is part of every test case, flow, and run key.

**Settings** (maintainers) has five sections:

| Section | What it does |
|---|---|
| General | Name and description |
| Members | Add registered users with a role, change roles, remove members |
| Run defaults | Starting values of the Run dialog for everyone in the project |
| Retention | How many days screenshots, videos, and attachments are kept (1–365). Runs and step results stay; old reports show "Artifact expired". |
| Danger zone | Archive the project (it disappears from lists and can't run; history is kept) |

![Project members and roles](img/project-members.png)

Only registered, active users can be added. To bring in someone new, an admin creates the user
first ([section 3](#3-managing-users-admin)).

## 5. Environments and secrets

**Environments** holds one entry per target, for example `staging` and `production`. The
environment marked **Default** (star) is used when a run doesn't pick one.

- **Variables** are plain values visible to every member. Use them in steps as
  `{{env.BASE_URL}}`. Edit the table, then **Save variables**.
- **Secrets** are write-only. **+ Secret** stores a value that nobody can view again; you can only
  **Replace value** or delete it. Use them as `{{secret.QA_PASSWORD}}`. Values are encrypted in
  the database (AES-256-GCM) and masked as `••••` in reports, logs, and MCP output.

![Environments with variables and write-only secrets](img/environments.png)

![Adding a secret](img/environments-secret-dialog.png)

Keep the same variable names across environments, so one test case runs against staging and
production by picking a different environment in the Run dialog.

## 6. Writing test cases

### The list

**Test cases** shows folders on the left and a filterable table on the right: search by title or
key, filter by status, priority, tags, execution (automated/manual), and last run. Filters live
in the URL, so you can bookmark or share a filtered view. Select rows with the checkboxes for
bulk actions: move to a folder, set status, add or remove a tag, delete.

![Test case list with folders and filters](img/test-cases-list.png)

**+ Test case** creates an automated test case; the arrow next to it also offers a manual one.

### The step editor

The editor has the step list on the left and the selected step's details on the right. Each row
shows the action, a readable summary, and the step's result from the last run (✓ passed,
✗ failed, ◌ skipped).

![Step editor with the side panel open on a selector step](img/step-editor-panel.png)

1. **Add step** (or press `N`) opens the **action palette**. Type to search by name or by what
   it does, then press `Enter`. The step is inserted after the selected one.
2. Fill the fields in the side panel. Required fields are marked as errors until filled; the
   tab label shows the number of errors.
3. Optional for every step: **Description** (shown in the report instead of the summary),
   **Expected** (the human-readable expected result), and under **Advanced**: a timeout,
   **Continue even if this step fails**, and **Always take a screenshot after this step**.
   Disable a step without deleting it with `E` or the row's **⋯** menu.
4. **Save** (`Ctrl S`). The first save gives the test case its key; every save adds a revision.

![Action palette filtered to HTTP actions](img/action-palette.png)

Actions are grouped in the palette:

| Group | Actions |
|---|---|
| Navigation | `goto` |
| Interaction | `click`, `dblclick`, `hover`, `fill`, `type`, `press`, `select_option`, `check`, `uncheck` |
| Wait | `wait_for` (prefer it), `wait` (fixed delay, max 30 s) |
| Data & variables | `extract_text`, `set_variable`, `screenshot` |
| UI assertions | `expect_visible`, `expect_hidden`, `expect_text`, `expect_value`, `expect_url`, `expect_title`, `expect_count` |
| HTTP | `http_request` (method, URL, headers, query, body; `save` JSONPath values into `vars`) |
| HTTP assertions | `expect_status`, `expect_json`, `expect_header`, `expect_response_time` |

A test case can mix UI and HTTP steps, for example create an order through the API and check it
in the UI. A browser is launched only when the test case has UI steps. HTTP assertions check the
response of the last `http_request`.

### Selectors

| Write | Finds | Playwright equivalent |
|---|---|---|
| `role=button[name='Pay now']` | A button by its accessible name | `getByRole('button', { name: 'Pay now' })` |
| `label=Email` | An input by its label | `getByLabel('Email')` |
| `placeholder=Search products` | An input by its placeholder | `getByPlaceholder('Search products')` |
| `testid=grand-total` | `data-testid="grand-total"` | `getByTestId('grand-total')` |
| `text=Order placed` | An element by its text | `getByText('Order placed')` |
| `#id`, `.class`, `xpath=…` | Anything else | `locator(…)` |

Prefer `role=`, `label=`, and `testid=`: they survive layout and styling changes. All actions
wait automatically for the element (Playwright auto-wait), so you rarely need `wait`.

### Variables

Type `{{` in any field to get suggestions.

| Namespace | Comes from | Example |
|---|---|---|
| `env.*` | The environment chosen for the run | `{{env.BASE_URL}}/login` |
| `secret.*` | Environment secrets (masked in reports) | `{{secret.QA_PASSWORD}}` |
| `vars.*` | The **Variables** tab of the test case or flow, plus `save` / `extract_text` / `set_variable` during the run | `{{vars.order_id}}` |
| `fn.*` | Built-in helpers | `{{fn.uuid}}`, `{{fn.now}}`, `{{fn.random_email}}`, `{{fn.random_int 1 100}}` |

When the same name is defined twice, the later source wins: environment → flow variables → test
case variables → values set during the run.

### JSON mode

**Form / JSON** at the top switches to the raw definition. JSON mode validates against the step
schema as you type, which is handy for copying steps between test cases or pasting a definition
an AI wrote.

![JSON mode with schema validation](img/step-editor-json.png)

### Keyboard shortcuts

**Shortcuts** (or `?`) lists them. They work when focus is in the step list, not inside a text
field.

| Key | Action |
|---|---|
| `↑` `↓` | Select step |
| `Enter` / `Esc` | Open step details / back to the list |
| `Alt ↑` `Alt ↓` | Move step |
| `Space` | Start dragging, `↑ ↓` to move, `Space` to drop |
| `N` | Add step (palette) |
| `D` | Duplicate |
| `E` | Enable / disable |
| `Del` | Delete (can be undone) |
| `Ctrl S` | Save |

![Keyboard shortcuts popover](img/editor-shortcuts.png)

The **Revisions** tab lists every saved version with its author and change note, shows the
differences against the current version, and can restore an old revision into the editor
(**Restore to draft**, then save). **Run history** shows the runs of this test case.

## 7. Manual test cases

Use a manual test case only for what a script can't check: an SMS one-time code, a printed or
downloaded document, a visual judgement, a physical device. Choose **Manual test case** from the
arrow next to **+ Test case**.

Each step has an **Instruction** (what the tester does) and an optional **Expected** result.
Variables work here too: `{{env.BASE_URL}}` is replaced with its value for the tester, secrets
are shown only by name.

![Manual test case editor](img/manual-test-case-editor.png)

Starting a manual test case creates a run in **Awaiting manual** for the chosen assignee (you by
default). See [Manual execution](#11-manual-execution).

## 8. Flows

A flow runs several test cases in order as one run, for example *log in → add to cart →
checkout*.

![Flows list](img/flows-list.png)

In the flow builder, search for test cases on the right and click (or press `Enter`) to append
them; drag the handles (or `Alt ↑ ↓`) to reorder.

![Flow builder with a manual test case in the middle](img/flow-builder.png)

| Option | Effect |
|---|---|
| **Shared session** on | One browser for the whole flow: cookies, login, and `vars` carry over to the next test case, and the flow records one video. Manual test cases are not allowed here. |
| **Shared session** off | Each test case starts in a fresh browser; runtime `vars` reset; one video per test case. Manual test cases are allowed. |
| **Stop on failure** | Later items are skipped after a failure, except items marked **Continue on failure**. |
| **Enabled** (per item) | Temporarily leave an item out without removing it. |
| **Variables** | Flow-level `{{vars.*}}`; a test case variable with the same name overrides it. |

A flow with manual test cases pauses at each one until the assignee finishes it, then the worker
continues automatically.

## 9. Running tests

**Run** on a test case or flow opens the Run dialog. Its starting values come from the project's
run defaults and your own last choices.

![Run dialog](img/run-dialog.png)

| Option | Values |
|---|---|
| Environment | Which variables and secrets to use (default: the starred environment) |
| Browser | Chromium, Firefox, WebKit (only the browsers installed on the worker can run; the default install has Chromium) |
| Viewport | Desktop 1280×720, laptop, mobile, or custom size |
| Screenshot | Off, On failure, Every step |
| Video | Off, On failure (records, then drops the video if the case passes), Always |
| Retries per test case | 0, 1, 2 |
| Advanced | Headless on/off, timeout per step (default 10 000 ms) |

For a manual test case or a flow with manual parts the dialog also asks for the **assignee**.

After **Run** you land on the run page. It updates live: queued → running → each step's result
as it happens, with elapsed time.

![A run in progress](img/run-live.png)

**Cancel** stops the running step and marks the rest Skipped; existing results are kept.
**Re-run** repeats the run with the same options; its menu also has **Re-run failed** (only the
failed test cases of a flow) and **Change options & run…**.

## 10. Reading reports

The **Steps** tab lists every test case of the run and its steps. A failed step opens
automatically with:

- **Expected** and **Actual** side by side,
- the error message from Playwright,
- the step's description and expected text,
- a screenshot thumbnail of the page at that moment.

![Failed run: expected vs actual with a screenshot](img/run-failed-report.png)

Here the test expected the voucher to bring the total down to Rp 81.000, but the page still
shows Rp 90.000. The demo shop has this bug on purpose.

**Screenshots** collects every screenshot of the run, labelled by case, step, and action. Click
one to open the lightbox: `←` `→` to move between them, **Download**, **Open in new tab**, `Esc`
to close.

![Screenshots tab](img/run-screenshots-tab.png)

![Screenshot lightbox](img/screenshot-lightbox.png)

**Video** plays the recording: one video for a shared-session flow, one per test case otherwise.

![Video tab](img/run-video-tab.png)

For `http_request` steps, expand the step to see method, URL, status, timing, and the request
and response bodies (secrets masked).

![HTTP request details](img/run-http-details.png)

**Details** shows the target, environment, trigger (Manual, via MCP, via API), timing, and the
exact run options. The **⋯** menu has **Copy link**, **Export JSON**, and **Download JUnit XML**.

Dark theme, same report:

![Failed run report in dark theme](img/dark-run-failed-report.png)

On a phone the report stacks vertically:

<img src="img/mobile-run-report.png" alt="Run report on a 390 px wide phone" width="320">

**Typical fix loop** (see the [video](video/fix-a-failing-test.mp4)): read expected vs actual
and the screenshot → decide whether the app or the test is wrong → if the test is wrong, click
the test case key, select the failing step, fix it, `Ctrl S` → **Run** again.

## 11. Manual execution

Manual runs assigned to you appear under **My tasks** (the sidebar shows the count), oldest
first.

![My tasks](img/my-tasks.png)

Open the task. The manual test case expands with its steps on the left and the current
instruction on the right:

1. Do what the **Instruction** says and compare with **Expected**.
2. Mark the step: **Pass** (`P`), **Fail** (`F`), **Blocked** (`B`), or **Skip** (`S`).
3. **Actual result**: what really happened. Required when a step fails.
4. **Attachments**: drop files, choose a file, or paste a screenshot (`Ctrl V`). Max 25 MB each.
5. `Ctrl Enter` saves and moves to the next step. Progress is saved as you go, so you can leave
   and come back.
6. **Finish** shows a summary and completes the test case.

![Executing a manual step: failed with an actual result](img/manual-execution.png)

**Change assignee** hands the work to someone else. In a flow, the worker continues with the next
automated test case as soon as you finish; with stop on failure, a failed manual case skips the
rest.

![The finished flow run with the manual results](img/manual-execution-done.png)

AI agents can start manual runs but can't fill in manual results: that stays with people.

## 12. Run history and dashboard

**Runs** lists every run of the project, newest first. Filter by target key, status, type (test
case or flow), trigger, and date range; the filters stay in the URL.

![Run history with the status filter open](img/runs-history.png)

The project **Dashboard** shows pass rate over 7 and 30 days, total runs, runs awaiting manual
work, a 30-day run trend, the most failing test cases, and recent runs.

![Project dashboard](img/dashboard.png)

![Project dashboard in dark theme](img/dark-dashboard.png)

<img src="img/mobile-dashboard.png" alt="Project dashboard on a 390 px wide phone" width="320">

## 13. API tokens and MCP for AI

QAtlas has an MCP server at `<your QAtlas URL>/mcp`, so an AI agent such as Claude Code can list
projects, write and validate test cases, run them, wait, and read the report, including the
screenshot of a failed step.

**Create a token:** **API tokens & MCP → Create token**. Pick the scopes you need:

| Scope | Allows |
|---|---|
| `read` | List and read projects, test cases, flows, runs, reports; validate |
| `write` | Create and edit test cases, folders, flows |
| `run` | Start and cancel runs |

You can limit a token to specific projects and give it an expiry (30 days, 90 days, none).

![Create token dialog](img/api-token-create.png)

The token is shown **once**, together with a ready-made Claude Code command. Copy it into your
password manager or straight into Claude Code.

![Token created, with the MCP setup command (token redacted in this screenshot)](img/api-token-created.png)

```bash
claude mcp add --transport http qatlas https://qatlas.example.com/mcp \
  --header "Authorization: Bearer qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Then ask Claude, for example: *"Create a login test case for project SHOP, run it on staging,
then summarize the results."* Claude uses the tools `list_projects`, `get_step_schema`,
`validate_test_case`, `create_test_case`, `run_test_case`, `wait_for_run`, `get_run_report` and
others (19 in total; reference: [docs/07-mcp.md](../07-mcp.md)).

- Runs started by an AI show **via MCP** as their trigger.
- A token may have at most 3 MCP runs queued or running at the same time.
- There is no delete tool, and AI can't fill in manual results.
- For clients that only speak stdio: `claude mcp add qatlas -e QATLAS_TOKEN=qat_… -- qatlas mcp-stdio --url https://qatlas.example.com`.

Revoke tokens you no longer use with **Revoke**. Revoked tokens stay in the list, marked.

![API tokens list](img/api-tokens.png)

## 14. CI

The same API token (scopes `read` + `run`) lets a CI job start a run, wait for it, fail the build
on a failed run, and keep a JUnit XML report. Setup, the `scripts/qatlas-ci.sh` client, and a
GitHub Actions example: [docs/ci/README.md](../ci/README.md).

## 15. Troubleshooting and FAQ

**I forgot my password.** Ask an admin to use **Create password reset link** on your row in
**Admin · Users**.

**"Continue with Google" says my account isn't registered.** Google sign-in only works for emails
an admin already created. Ask an admin to create your user with that exact email.

**I can't see the Run / Edit / Settings buttons.** You are a viewer in this project. Ask a
maintainer to make you an editor.

**A step fails with a timeout.** The element never appeared or never matched. Open the step's
screenshot: is the page what you expected? Check the selector (prefer `role=`, `label=`,
`testid=`), and use `wait_for` instead of `wait` for slow pages. The default step timeout is
10 s; raise it per step under **Advanced** or per run in the Run dialog.

**The run status is Error, not Failed.** Error means the infrastructure failed (the browser
crashed, the worker restarted, the run timed out), not an assertion. The message is in the run
header. Re-run; if it repeats, check the worker log.

**A run stays Queued.** No worker is picking up jobs. Check that `qatlas worker` (or
`qatlas all`) is running and its log says `runner ready`.

**The screenshot or video says "Artifact expired".** The project's retention removed it. Runs and
step results stay.

**Firefox or WebKit runs fail to start.** The worker only has the browsers that were installed on
it (the default install has Chromium; `deploy/install.sh --browsers "chromium webkit"` adds
more).

**Live progress doesn't update behind a reverse proxy.** Progress uses Server-Sent Events: the
proxy must not buffer `/api/v1/runs/{key}/events`. See the nginx example in
[deploy/README.md](../../deploy/README.md#reverse-proxy-and-tls).

**Can I put a password in test case variables?** Don't: test case variables are visible to every
member. Store it as an environment secret and use `{{secret.NAME}}`.

---

### Regenerating the screenshots and videos

The media are produced by scripts in [`scripts/`](scripts/README.md) against a running demo
instance, so they can be refreshed after UI changes.
