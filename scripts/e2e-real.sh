#!/usr/bin/env bash
# Real-mode end-to-end test of the full stack:
#   Postgres (database qatlas_e2e, recreated) → qatlas migrate + seed demo → runner build →
#   Mailpit (free random SMTP/API ports, throwaway database) → demo-target (:8099) →
#   qatlas all (:8090, API + worker) → Vite in real API mode (:5320) →
#   E2E_MODE=real playwright test (web/e2e). Everything started here is stopped on exit.
#
#   scripts/e2e-real.sh                    # whole suite
#   scripts/e2e-real.sh -g J12             # extra arguments go to `playwright test`
#   KEEP_LOGS=1 scripts/e2e-real.sh        # keep the log/data directory after a green run
#
# Needs: Go, Node 22 + corepack pnpm (workspace installed), Playwright browsers, and the dev
# Postgres (make dev-db, container qatlas-dev-postgres on 127.0.0.1:55432) — or `psql` with
# E2E_PG_ADMIN_URL pointing at a database that may create/drop qatlas_e2e.
#
# Overrides: E2E_DB_NAME (qatlas_e2e), E2E_PG_CONTAINER (qatlas-dev-postgres),
# E2E_PG_HOSTPORT (127.0.0.1:55432), E2E_PG_USER / E2E_PG_PASSWORD (qatlas),
# API_PORT (8090), DEMO_PORT (8099), WEB_PORT (5320), MAILPIT_BIN_DIR (where the pinned Mailpit
# is downloaded once; default ~/.local/state/qatlas-demo/bin, shared with scripts/demo-server.sh).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_NAME="${E2E_DB_NAME:-qatlas_e2e}"
PG_CONTAINER="${E2E_PG_CONTAINER:-qatlas-dev-postgres}"
PG_HOSTPORT="${E2E_PG_HOSTPORT:-127.0.0.1:55432}"
PG_USER="${E2E_PG_USER:-qatlas}"
PG_PASSWORD="${E2E_PG_PASSWORD:-qatlas}"
API_PORT="${API_PORT:-8090}"
DEMO_PORT="${DEMO_PORT:-8099}"
WEB_PORT="${WEB_PORT:-5320}"
MAILPIT_BIN_DIR="${MAILPIT_BIN_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/qatlas-demo/bin}"
PNPM=(corepack pnpm)
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORK="$(mktemp -d "${TMPDIR:-/tmp}/qatlas-e2e-real.XXXXXX")"
PIDS=()

log() { printf '\n\033[1m[e2e-real] %s\033[0m\n' "$*"; }

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((${#PIDS[@]})); then
    log "stopping services"
    for pid in "${PIDS[@]}"; do
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]}"; do
      for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  if ((status != 0)); then
    log "FAILED (exit $status) — logs kept in $WORK"
    for f in "$WORK"/*.log; do
      [[ -f $f ]] || continue
      printf '\n----- %s (last 40 lines) -----\n' "$(basename "$f")"
      tail -n 40 "$f"
    done
  elif [[ -n ${KEEP_LOGS:-} ]]; then
    log "logs kept in $WORK"
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# A port the kernel considers free right now (bind :0, read it back, release it).
# (process.stdout.write, not console.log: FORCE_COLOR would colour the number.)
free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'; }

wait_http() { # url name pid
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "$1" 2>/dev/null; then return 0; fi
    if ! kill -0 "$3" 2>/dev/null; then echo "$2 exited early" >&2; return 1; fi
    sleep 0.5
  done
  echo "$2 did not become ready at $1" >&2
  return 1
}

# start NAME CMD… — own session/process group so teardown also stops children (pnpm → vite).
start() {
  local name=$1
  shift
  setsid "$@" >"$WORK/$name.log" 2>&1 &
  PIDS+=("$!")
}

for p in "$API_PORT" "$DEMO_PORT" "$WEB_PORT"; do
  port_free "$p" || { echo "port $p is already in use" >&2; exit 1; }
done

# ------------------------------------------------------------------ database
log "recreating database $DB_NAME"
if docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  docker exec "$PG_CONTAINER" dropdb -U "$PG_USER" --if-exists --force "$DB_NAME"
  docker exec "$PG_CONTAINER" createdb -U "$PG_USER" "$DB_NAME"
elif command -v psql >/dev/null 2>&1; then
  admin_url="${E2E_PG_ADMIN_URL:-postgres://$PG_USER:$PG_PASSWORD@$PG_HOSTPORT/postgres?sslmode=disable}"
  psql "$admin_url" -v ON_ERROR_STOP=1 -qc "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" -c "CREATE DATABASE \"$DB_NAME\""
else
  echo "need the $PG_CONTAINER container (make dev-db) or psql" >&2
  exit 1
fi

export QATLAS_DATABASE_URL="postgres://$PG_USER:$PG_PASSWORD@$PG_HOSTPORT/$DB_NAME?sslmode=disable"
export QATLAS_MASTER_KEY
QATLAS_MASTER_KEY="$(head -c 32 /dev/urandom | base64)"
export QATLAS_HTTP_ADDR="127.0.0.1:$API_PORT"
export QATLAS_BASE_URL="http://127.0.0.1:$WEB_PORT" # invite links point at the web server
export QATLAS_DATA_DIR="$WORK/data"
export QATLAS_LOG_LEVEL=info
unset QATLAS_WEB_DIR QATLAS_RUNNER_CMD GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
DEMO_ADMIN_TOKEN="adm_e2e_$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export DEMO_ADMIN_TOKEN

# ------------------------------------------------------------------ build
log "building qatlas and the runner"
(cd "$ROOT/backend" && go build -ldflags "-X main.version=e2e" -o "$WORK/qatlas" ./cmd/qatlas)
"${PNPM[@]}" --filter @qatlas/runner build >"$WORK/runner-build.log" 2>&1
MAILPIT="$("$ROOT/scripts/fetch-mailpit.sh" "$MAILPIT_BIN_DIR")" # pinned + checksum-verified, downloaded once
MAIL_SMTP_PORT="$(free_port)"
MAIL_PORT="$(free_port)"
while [[ $MAIL_PORT == "$MAIL_SMTP_PORT" ]]; do MAIL_PORT="$(free_port)"; done

log "migrating and seeding"
"$WORK/qatlas" migrate up >"$WORK/migrate.log" 2>&1
"$WORK/qatlas" seed demo --target-url "http://localhost:$DEMO_PORT" --admin-token "$DEMO_ADMIN_TOKEN" \
  --mailpit-url "http://127.0.0.1:$MAIL_PORT" | tee "$WORK/seed.log"

# ------------------------------------------------------------------ services
log "starting mailpit :$MAIL_SMTP_PORT/:$MAIL_PORT, demo-target :$DEMO_PORT, qatlas all :$API_PORT, vite (real mode) :$WEB_PORT"
start mailpit "$MAILPIT" --smtp "127.0.0.1:$MAIL_SMTP_PORT" --listen "127.0.0.1:$MAIL_PORT" \
  --database "$WORK/mailpit.db" --disable-version-check
MAIL_PID=${PIDS[-1]}
start demo-target env PORT="$DEMO_PORT" HOST=127.0.0.1 DEMO_LANG=en DEMO_ADMIN_TOKEN="$DEMO_ADMIN_TOKEN" \
  DEMO_SMTP_HOST=127.0.0.1 DEMO_SMTP_PORT="$MAIL_SMTP_PORT" DEMO_PUBLIC_URL="http://localhost:$DEMO_PORT" \
  node "$ROOT/demo-target/server.mjs"
DEMO_PID=${PIDS[-1]}
# From the repo root so the default runner command finds runner/dist/main.js.
start qatlas bash -c "cd '$ROOT' && exec '$WORK/qatlas' all"
API_PID=${PIDS[-1]}
start vite bash -c "cd '$ROOT/web' && VITE_API_MODE=real QATLAS_API_URL='http://127.0.0.1:$API_PORT' exec ${PNPM[*]} exec vite --host 127.0.0.1 --port '$WEB_PORT' --strictPort"
WEB_PID=${PIDS[-1]}

wait_http "http://127.0.0.1:$MAIL_PORT/readyz" mailpit "$MAIL_PID"
wait_http "http://127.0.0.1:$DEMO_PORT/api/health" demo-target "$DEMO_PID"
wait_http "http://127.0.0.1:$API_PORT/readyz" "qatlas all" "$API_PID"
wait_http "http://127.0.0.1:$WEB_PORT/" vite "$WEB_PID"
curl -fsS "http://127.0.0.1:$WEB_PORT/api/v1/auth/config" >/dev/null # proxy reaches the API

# ------------------------------------------------------------------ tests
log "running E2E_MODE=real playwright test $*"
(cd "$ROOT/web" && E2E_MODE=real E2E_BASE_URL="http://127.0.0.1:$WEB_PORT" "${PNPM[@]}" exec playwright test "$@")
log "real-mode e2e passed"
