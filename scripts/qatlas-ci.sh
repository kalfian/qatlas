#!/usr/bin/env bash
# qatlas-ci.sh — start a QAtlas run from CI, wait for it, download the JUnit report.
#
#   QATLAS_URL=https://qatlas.example.com QATLAS_TOKEN=qat_… \
#     scripts/qatlas-ci.sh --project SHOP --flow SHOP-F2 --junit qatlas-junit.xml
#
# Options:
#   --project KEY           project key (required), e.g. SHOP
#   --test-case KEY         run one test case, e.g. SHOP-T1        ┐ exactly one
#   --flow KEY              run a flow, e.g. SHOP-F2               ┘
#   --environment ID        environment id (default: the project's default environment)
#   --timeout SECONDS       give up waiting after this long (default 900); the run is cancelled
#   --interval SECONDS      poll interval (default 3)
#   --junit FILE            write the run's JUnit XML to FILE once the run has finished
#   -h, --help              show this help
#
# Environment:
#   QATLAS_URL    base URL of the QAtlas server (no /api/v1)
#   QATLAS_TOKEN  API token (Settings → API tokens) with scopes `read` + `run`
#
# Exit codes: 0 run passed · 1 run failed / error / blocked / cancelled / timed out ·
#             2 usage, network or API error (no verdict).
# If GITHUB_STEP_SUMMARY is set (GitHub Actions), a short Markdown summary is appended to it.
#
# Needs bash, curl and jq. The token is passed to curl on stdin, never on its command line.

set -uo pipefail

PROG=${0##*/}
PROJECT="" TEST_CASE="" FLOW="" ENVIRONMENT="" JUNIT=""
TIMEOUT=900 INTERVAL=3

say() { printf '[qatlas] %s\n' "$*" >&2; }
die() { say "error: $*"; exit 2; }
usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p}' "$0" | sed '$d'; }

while (($#)); do
  case $1 in
    --project) PROJECT=${2:-}; shift 2 || die "--project needs a value" ;;
    --test-case) TEST_CASE=${2:-}; shift 2 || die "--test-case needs a value" ;;
    --flow) FLOW=${2:-}; shift 2 || die "--flow needs a value" ;;
    --environment) ENVIRONMENT=${2:-}; shift 2 || die "--environment needs a value" ;;
    --timeout) TIMEOUT=${2:-}; shift 2 || die "--timeout needs a value" ;;
    --interval) INTERVAL=${2:-}; shift 2 || die "--interval needs a value" ;;
    --junit) JUNIT=${2:-}; shift 2 || die "--junit needs a value" ;;
    --project=*) PROJECT=${1#*=}; shift ;;
    --test-case=*) TEST_CASE=${1#*=}; shift ;;
    --flow=*) FLOW=${1#*=}; shift ;;
    --environment=*) ENVIRONMENT=${1#*=}; shift ;;
    --timeout=*) TIMEOUT=${1#*=}; shift ;;
    --interval=*) INTERVAL=${1#*=}; shift ;;
    --junit=*) JUNIT=${1#*=}; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is required"
done
[[ -n ${QATLAS_URL:-} ]] || die "QATLAS_URL is not set"
[[ -n ${QATLAS_TOKEN:-} ]] || die "QATLAS_TOKEN is not set"
[[ -n $PROJECT ]] || die "--project is required (see --help)"
if [[ -n $TEST_CASE && -n $FLOW ]] || [[ -z $TEST_CASE && -z $FLOW ]]; then
  die "give exactly one of --test-case or --flow"
fi
[[ $TIMEOUT =~ ^[0-9]+$ && $TIMEOUT -gt 0 ]] || die "--timeout must be a positive number of seconds"
[[ $INTERVAL =~ ^[0-9]+$ && $INTERVAL -gt 0 ]] || die "--interval must be a positive number of seconds"

BASE=${QATLAS_URL%/}
API="$BASE/api/v1"
PROJECT=$(printf '%s' "$PROJECT" | tr '[:lower:]' '[:upper:]')
TMP=$(mktemp -d "${TMPDIR:-/tmp}/qatlas-ci.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$TMP"' EXIT

# api METHOD PATH [JSON_BODY_FILE] → response body in $TMP/body, HTTP status in $STATUS.
STATUS=0
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -o "$TMP/body" -w '%{http_code}'
    -H 'Accept: application/json' -H 'User-Agent: qatlas-ci/1' --connect-timeout 10 --max-time 60)
  [[ -n $body ]] && args+=(-H 'Content-Type: application/json' --data-binary "@$body")
  : >"$TMP/body"
  STATUS=$(curl "${args[@]}" --config - "$API$path" <<<"header = \"Authorization: Bearer $QATLAS_TOKEN\"") || STATUS=0
}

api_error() { # human-readable error of the last response
  local msg
  msg=$(jq -r '.error | "\(.message) (\(.code))"' "$TMP/body" 2>/dev/null) || msg=""
  [[ -n $msg && $msg != "null (null)" ]] || msg=$(head -c 300 "$TMP/body")
  if ((STATUS == 0)); then printf 'no response from %s' "$BASE"; else printf 'HTTP %s: %s' "$STATUS" "$msg"; fi
}

# ------------------------------------------------------------------ start the run
jq -n --arg tc "$TEST_CASE" --arg flow "$FLOW" --arg env "$ENVIRONMENT" '
  (if $tc != "" then {test_case: ($tc | ascii_upcase)} else {flow: ($flow | ascii_upcase)} end)
  + (if $env != "" then {environment_id: $env} else {} end)' >"$TMP/create.json"

api POST "/projects/$PROJECT/runs" "$TMP/create.json"
((STATUS == 202)) || die "could not start the run: $(api_error)"
RUN_KEY=$(jq -r '.key' "$TMP/body")
TARGET=$(jq -r '"\(.target.key) \(.target.title)"' "$TMP/body")
ENV_NAME=$(jq -r '.environment.name // "no environment"' "$TMP/body")
RUN_URL="$BASE/p/$PROJECT/runs/$RUN_KEY"
say "started $RUN_KEY — $TARGET ($ENV_NAME)"
say "run: $RUN_URL"

# ------------------------------------------------------------------ wait
is_final() { case $1 in passed | failed | blocked | error | cancelled) return 0 ;; esac; return 1; }

start=$SECONDS last_line="" last_print=0 errors=0 status="" manual_note="" timed_out=""
while :; do
  api GET "/runs/$RUN_KEY"
  if ((STATUS == 200)); then
    errors=0
    status=$(jq -r '.status' "$TMP/body")
    line=$(jq -r '.summary.cases as $c |
      "\(.status) · cases \($c.total - $c.other)/\($c.total) done (passed \($c.passed), failed \($c.failed), blocked \($c.blocked), skipped \($c.skipped))"' "$TMP/body")
    elapsed=$((SECONDS - start))
    if [[ $line != "$last_line" ]] || ((elapsed - last_print >= 60)); then
      say "$RUN_KEY $line · ${elapsed}s"
      last_line=$line last_print=$elapsed
    fi
    if [[ $status == awaiting_manual && -z $manual_note ]]; then
      manual_note=1
      say "$RUN_KEY waits for a tester ($(jq -r '.assignee.name // "unassigned"' "$TMP/body")) to execute a manual test case"
    fi
    is_final "$status" && break
  elif ((STATUS == 401 || STATUS == 403 || STATUS == 404)); then
    die "cannot read $RUN_KEY: $(api_error)"
  else
    errors=$((errors + 1))
    say "warning: polling failed ($(api_error)), attempt $errors/5"
    ((errors < 5)) || die "giving up on $RUN_KEY after repeated errors — $RUN_URL"
  fi
  if ((SECONDS - start >= TIMEOUT)); then
    say "timed out after ${TIMEOUT}s (status ${status:-unknown}); cancelling $RUN_KEY"
    timed_out=1
    api POST "/runs/$RUN_KEY/cancel"
    if ((STATUS == 200)); then
      # A running run stops within a few seconds; then the report can still be written.
      for _ in $(seq 1 20); do
        api GET "/runs/$RUN_KEY"
        ((STATUS == 200)) && status=$(jq -r '.status' "$TMP/body") && is_final "$status" && break
        sleep 1
      done
    else
      say "warning: cancel failed: $(api_error)"
    fi
    if ((STATUS != 200)) || ! is_final "$status"; then
      say "run: $RUN_URL"
      exit 1
    fi
    break
  fi
  sleep "$INTERVAL"
done

cp "$TMP/body" "$TMP/run.json"
summary=$(jq -r '.summary.cases | "\(.total) cases: \(.passed) passed, \(.failed) failed, \(.blocked) blocked, \(.skipped) skipped"' "$TMP/run.json")
say "$RUN_KEY finished: $status — $summary"
jq -r '.cases[] | select(.status == "failed" or .status == "error" or .status == "blocked") |
  "  ✗ \(.test_case_key) \(.title) [\(.status)]" +
  ([.steps[] | select(.status == "failed" or .status == "error" or .status == "blocked")][0] |
    if . then "\n      step \(.position): \(.summary)" + (if .error_message then " — \(.error_message | gsub("\u001b\\[[0-9;]*m"; "") | .[0:300])" else "" end) else "" end)' \
  "$TMP/run.json" >&2
[[ $status == error ]] && jq -r '.error_message // empty | "  run error: \(.)"' "$TMP/run.json" >&2

# ------------------------------------------------------------------ JUnit
rc=1
[[ $status == passed && -z $timed_out ]] && rc=0
if [[ -n $JUNIT ]]; then
  api GET "/runs/$RUN_KEY/junit.xml"
  if ((STATUS == 200)); then
    mkdir -p "$(dirname -- "$JUNIT")" && cp "$TMP/body" "$JUNIT" || die "cannot write $JUNIT"
    say "JUnit report: $JUNIT"
  else
    say "error: JUnit download failed: $(api_error)"
    rc=2
  fi
fi

if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  {
    icon="❌"
    [[ $status == passed ]] && icon="✅"
    printf '### %s QAtlas %s — %s\n\n' "$icon" "$RUN_KEY" "$status"
    printf '%s · %s · [open run](%s)\n\n' "$TARGET" "$ENV_NAME" "$RUN_URL"
    printf '| Test case | Status | Duration |\n|---|---|---|\n'
    jq -r '.cases[] | "| \(.test_case_key) \(.title | gsub("\\|"; "\\|")) | \(.status) | \(if .duration_ms then "\(.duration_ms / 1000 | . * 10 | round / 10) s" else "–" end) |"' "$TMP/run.json"
    printf '\n'
  } >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || say "warning: could not write GITHUB_STEP_SUMMARY"
fi

say "run: $RUN_URL"
exit "$rc"
