# Running QAtlas from CI

Trigger a QAtlas run from any CI system, wait for the verdict and keep a JUnit XML report:

- [`scripts/qatlas-ci.sh`](../../scripts/qatlas-ci.sh): bash + curl + jq client. It starts a run,
  polls it until it finishes, downloads the JUnit report and exits with the verdict.
- [`github-actions.example.yml`](github-actions.example.yml): a GitHub Actions workflow that uses
  the script, uploads the report as an artifact and publishes a test summary. It is an example and
  lives here, not under `.github/`, so it never runs in this repository.

## 1. Create an API token

In QAtlas open **Settings → API tokens**, create a token for a CI user and copy it. You only see it once.

| Scope | Needed for |
|---|---|
| `read` | polling `GET /runs/{runKey}` and downloading `GET /runs/{runKey}/junit.xml` |
| `run` | starting the run (`POST /projects/{key}/runs`) and cancelling it on timeout |

Give the token **`read` + `run`** and nothing else. It does not need `write`. Tokens act as the
user who created them, so that user must be an **editor** or **maintainer** of the project (viewers
cannot start runs). You can also limit the token to specific projects and give it an expiry date. Runs started with a token
show the trigger "API". Token requests use `Authorization: Bearer`, so they don't need the CSRF header.

Store the token as a CI secret (`QATLAS_TOKEN`) and the server URL as a variable (`QATLAS_URL`).
Never put the token in the repository or on a command line. The script passes it to curl on
stdin, so it doesn't appear in the process list.

## 2. Run the script

```sh
export QATLAS_URL=https://qatlas.example.com
export QATLAS_TOKEN=qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

scripts/qatlas-ci.sh --project SHOP --flow SHOP-F2 --junit reports/qatlas-junit.xml
scripts/qatlas-ci.sh --project SHOP --test-case SHOP-T1 --environment <environment-id> --timeout 600
```

| Option | Default | |
|---|---|---|
| `--project KEY` | required | project key |
| `--test-case KEY` / `--flow KEY` | exactly one | what to run |
| `--environment ID` | project default | environment id (see `GET /projects/{key}/environments`) |
| `--timeout SECONDS` | `900` | after this the script cancels the run and fails |
| `--interval SECONDS` | `3` | poll interval |
| `--junit FILE` | none | write the JUnit XML here (also after a failure or timeout) |

The script prints the run URL (`$QATLAS_URL/p/<project>/runs/<runKey>`), a progress line whenever
the status or case counts change, and the failing steps at the end. If `GITHUB_STEP_SUMMARY` is
set, it also appends a Markdown table with a link to the run.

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | run **passed** |
| `1` | run **failed**, **error**, **blocked** or **cancelled**, or it did not finish within `--timeout` (the script cancels it) |
| `2` | usage error, or the API could not be reached or refused the request (bad token, missing scope, unknown test case …). There is no verdict |

Runs that contain **manual** test cases wait for a tester (`awaiting_manual`). The script reports
this and keeps waiting until `--timeout`, so CI pipelines should normally run automated flows only.

## 3. The JUnit report

`GET /api/v1/runs/{runKey}/junit.xml` works for **finished** runs only. While a run is queued,
running or waiting for a tester, the endpoint returns `409 conflict`. The report contains:

- one `<testsuite>` per run: name = target key + title, `id` = run key, `timestamp` = start time
  (UTC), `time` in seconds, `<properties>` `qatlas.*` (status, environment, trigger, browser)
- one `<testcase>` per test case in the run: `classname` = project key, `name` = test case key + title
- `failed` → `<failure>` with the failed step, its error and expected vs actual. `blocked` (manual)
  → `<failure type="blocked">`. `error` (infrastructure, e.g. runner crash or timeout) → `<error>`.
  `skipped` → `<skipped/>`
- `<system-out>` with every step and its status. Manual cases also show the tester and the actual results

Secret values never appear in the report. They are masked (`••••`) before run results are stored.
The same file can be downloaded in the UI: on the run page, open **⋯ → Download JUnit XML**.

## 4. GitHub Actions

Copy [`github-actions.example.yml`](github-actions.example.yml) to `.github/workflows/` in the
repository of the application under test, and copy the script to `ci/qatlas-ci.sh`. Then add the
`QATLAS_TOKEN` secret and the `QATLAS_URL` variable. The workflow:

1. runs the flow after a successful deploy workflow, or by hand (`workflow_dispatch`)
2. fails the job when the run does not pass (script exit code)
3. uploads `reports/qatlas-junit.xml` as an artifact and publishes it as a check with a test summary
   (`mikepenz/action-junit-report`), both with `if: always()`

Only the step that runs the script gets `QATLAS_TOKEN`. The third-party actions don't see it.

For other CI systems (GitLab CI, Bitbucket Pipelines, Jenkins …), the pattern is the same: run the
script in an image that has bash, curl and jq, then point the platform's JUnit report option at the
`--junit` file. For example, GitLab uses `artifacts:reports:junit` and Jenkins uses the `junit` step.
