#!/usr/bin/env bash
# Menjalankan QAtlas versi real (backend Go + worker + runner Playwright + demo target) untuk
# review di satu host, tanpa Docker/systemd. Untuk produksi pakai deploy/ (lihat deploy/README.md).
#
#   scripts/demo-server.sh start     build (bila perlu), migrate, seed demo, jalankan semua
#   scripts/demo-server.sh stop      hentikan semua proses
#   scripts/demo-server.sh status    tampilkan status
#   scripts/demo-server.sh reset     stop + hapus database & data demo
#
# Konfigurasi (env, opsional): QATLAS_DEMO_PORT (8090), DEMO_TARGET_PORT (8099),
# QATLAS_DEMO_PUBLIC_URL (http://<ip-pertama>:8090), QATLAS_DEMO_DB (qatlas_demo),
# DEMO_MAILPIT_SMTP_PORT (1025), DEMO_MAILPIT_PORT (8025, UI + API).
# Secret (master key, token demo) dibuat sekali di ~/.config/qatlas/demo.env (chmod 600).
#
# Mailpit (penangkap email untuk test case daftar + verifikasi email) diunduh sekali ke
# $STATE/bin lewat scripts/fetch-mailpit.sh (rilis tersemat, checksum SHA-256 diverifikasi) dan
# hanya listen di 127.0.0.1: SMTP :1025, UI/API http://127.0.0.1:8025.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/qatlas-demo"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qatlas"
CONF="$CONF_DIR/demo.env"
PORT="${QATLAS_DEMO_PORT:-8090}"
TARGET_PORT="${DEMO_TARGET_PORT:-8099}"
DB="${QATLAS_DEMO_DB:-qatlas_demo}"
PG="127.0.0.1:55432"
MAILPIT_SMTP_PORT="${DEMO_MAILPIT_SMTP_PORT:-1025}"
MAILPIT_PORT="${DEMO_MAILPIT_PORT:-8025}"
PUBLIC_URL="${QATLAS_DEMO_PUBLIC_URL:-http://$(hostname -I | awk '{print $1}'):$PORT}"

log() { printf '\033[1m[demo]\033[0m %s\n' "$*"; }

running() { [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null; }

stop_one() {
  if running "$1"; then
    local pid; pid="$(cat "$STATE/$1.pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    log "stopped $1"
  fi
  rm -f "$STATE/$1.pid"
}

ensure_conf() {
  mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
  if [[ ! -f "$CONF" ]]; then
    umask 077
    cat >"$CONF" <<EOF
QATLAS_MASTER_KEY=$(head -c 32 /dev/urandom | base64)
DEMO_ADMIN_TOKEN=adm_demo_$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')
EOF
    log "created $CONF"
  fi
  # shellcheck disable=SC1090
  set -a; . "$CONF"; set +a
}

start_mailpit() {
  running mailpit && return
  local bin
  bin="$("$ROOT/scripts/fetch-mailpit.sh" "$STATE/bin")" # pinned release, checksum-verified, downloaded once
  log "starting Mailpit smtp 127.0.0.1:$MAILPIT_SMTP_PORT, ui/api http://127.0.0.1:$MAILPIT_PORT"
  setsid "$bin" --smtp "127.0.0.1:$MAILPIT_SMTP_PORT" --listen "127.0.0.1:$MAILPIT_PORT" \
    --database "$STATE/mailpit.db" --max 500 --disable-version-check \
    >"$STATE/mailpit.log" 2>&1 </dev/null &
  echo $! >"$STATE/mailpit.pid"
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$MAILPIT_PORT/readyz" >/dev/null 2>&1 && return; sleep 0.5; done
  tail -20 "$STATE/mailpit.log"; exit 1
}

start() {
  mkdir -p "$STATE"
  ensure_conf
  if running qatlas; then log "already running → $PUBLIC_URL"; return; fi
  log "building (make build)"
  make -C "$ROOT" build >"$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; exit 1; }

  docker exec qatlas-dev-postgres psql -U qatlas -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1 \
    || docker exec qatlas-dev-postgres createdb -U qatlas "$DB"

  export QATLAS_DATABASE_URL="postgres://qatlas:qatlas@$PG/$DB?sslmode=disable"
  export QATLAS_HTTP_ADDR="0.0.0.0:$PORT"
  export QATLAS_BASE_URL="$PUBLIC_URL"
  export QATLAS_WEB_DIR="$ROOT/dist/web"
  export QATLAS_DATA_DIR="$STATE/data"
  export QATLAS_LOG_LEVEL=info
  mkdir -p "$QATLAS_DATA_DIR"

  "$ROOT/dist/qatlas" migrate up >"$STATE/migrate.log" 2>&1 || { cat "$STATE/migrate.log"; exit 1; }

  start_mailpit

  log "starting demo target :$TARGET_PORT"
  setsid env PORT="$TARGET_PORT" HOST=127.0.0.1 DEMO_LANG=en DEMO_ADMIN_TOKEN="$DEMO_ADMIN_TOKEN" \
    DEMO_SMTP_HOST=127.0.0.1 DEMO_SMTP_PORT="$MAILPIT_SMTP_PORT" DEMO_PUBLIC_URL="http://localhost:$TARGET_PORT" \
    node "$ROOT/demo-target/server.mjs" >"$STATE/demo-target.log" 2>&1 </dev/null &
  echo $! >"$STATE/demo-target.pid"

  log "starting qatlas all :$PORT"
  setsid "$ROOT/dist/qatlas" all >"$STATE/qatlas.log" 2>&1 </dev/null &
  echo $! >"$STATE/qatlas.pid"

  for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { tail -40 "$STATE/qatlas.log"; exit 1; }

  if [[ ! -f "$STATE/seeded" ]]; then
    log "seeding demo data (+ a few real runs)"
    "$ROOT/dist/qatlas" seed demo --target-url "http://localhost:$TARGET_PORT" --admin-token "$DEMO_ADMIN_TOKEN" \
      --mailpit-url "http://localhost:$MAILPIT_PORT" --runs \
      >"$STATE/seed.log" 2>&1 || { cat "$STATE/seed.log"; exit 1; }
    touch "$STATE/seeded"
  fi
  log "ready → $PUBLIC_URL  (login rina@tokoku.id / password123; Mailpit http://127.0.0.1:$MAILPIT_PORT; logs in $STATE)"
}

status() {
  for p in qatlas demo-target mailpit; do
    if running "$p"; then echo "$p: running (pid $(cat "$STATE/$p.pid"))"; else echo "$p: stopped"; fi
  done
  curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null && echo
  echo "url: $PUBLIC_URL"
  echo "mailpit: http://127.0.0.1:$MAILPIT_PORT (smtp 127.0.0.1:$MAILPIT_SMTP_PORT)"
}

case "${1:-}" in
  start) start ;;
  stop) stop_one qatlas; stop_one demo-target; stop_one mailpit ;;
  status) status ;;
  reset)
    stop_one qatlas; stop_one demo-target; stop_one mailpit
    docker exec qatlas-dev-postgres dropdb -U qatlas --if-exists "$DB"
    # Everything except the downloaded binaries (bin/) — no re-download after a reset.
    [[ -d $STATE ]] && find "$STATE" -mindepth 1 -maxdepth 1 ! -name bin -exec rm -rf {} +
    log "reset done"
    ;;
  *) echo "usage: $0 start|stop|status|reset" >&2; exit 2 ;;
esac
