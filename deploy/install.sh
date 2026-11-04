#!/usr/bin/env bash
# QAtlas manual installer / upgrader (docs/12-deployment.md, option B: binary + systemd).
#
# Run as root from an unpacked release (`make release` →
# dist/qatlas-<version>-linux-amd64.tar.gz):
#
#   tar -xzf qatlas-<version>-linux-amd64.tar.gz
#   sudo ./qatlas-<version>-linux-amd64/deploy/install.sh [options]
#
# Idempotent: re-running with the same release re-installs it; running it with a
# newer release is the upgrade path. Steps: system user + directories, release
# into /opt/qatlas/releases/<version>, runner deps (npm ci) + Playwright browsers,
# /etc/qatlas/qatlas.env (first run only), systemd units, `qatlas migrate up`,
# switch /opt/qatlas/current, (re)start services, prune old releases.
set -Eeuo pipefail

PREFIX=/opt/qatlas
RELEASES=$PREFIX/releases
BROWSERS=$PREFIX/ms-playwright
ETC=/etc/qatlas
ENV_FILE=$ETC/qatlas.env
MODE_FILE=$ETC/install-mode
DATA=/var/lib/qatlas
SVC_USER=qatlas
UNIT_DIR=/etc/systemd/system
WRAPPER=/usr/local/sbin/qatlas
MIN_NODE_MAJOR=22

usage() {
	cat <<'EOF'
Usage: install.sh [options]

  --release-dir DIR|FILE   unpacked release directory or release .tar.gz
                           (default: the release this script belongs to)
  --mode MODE              split  = qatlas-server + qatlas-worker (default on first install)
                           all    = one qatlas.service running `qatlas all`
                           server = qatlas-server only (worker on another LXC)
                           worker = qatlas-worker only (server on another LXC)
                           Default: the mode of the previous install.
  --browsers "LIST"        Playwright browsers to install (default: "chromium";
                           e.g. "chromium webkit firefox")
  --skip-browsers          do not run `playwright install --with-deps`
  --skip-migrate           do not run `qatlas migrate up`
  --no-start               install everything but do not (re)start services
  --keep N                 releases to keep in /opt/qatlas/releases (default 5)
  -h, --help               this help
EOF
}

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELEASE_ARG=""
MODE=""
BROWSER_LIST="chromium"
SKIP_BROWSERS=0
SKIP_MIGRATE=0
NO_START=0
KEEP=5

while [[ $# -gt 0 ]]; do
	case "$1" in
	--release-dir) RELEASE_ARG=${2:?--release-dir needs a value}; shift 2 ;;
	--mode) MODE=${2:?--mode needs a value}; shift 2 ;;
	--browsers) BROWSER_LIST=${2:?--browsers needs a value}; shift 2 ;;
	--skip-browsers) SKIP_BROWSERS=1; shift ;;
	--skip-migrate) SKIP_MIGRATE=1; shift ;;
	--no-start) NO_START=1; shift ;;
	--keep) KEEP=${2:?--keep needs a value}; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) usage >&2; die "unknown option: $1" ;;
	esac
done

[[ $EUID -eq 0 ]] || die "run as root (sudo $0 …)"
[[ $KEEP =~ ^[0-9]+$ && $KEEP -ge 2 ]] || die "--keep must be an integer >= 2"

TMP_WORK=""
cleanup() { [[ -n $TMP_WORK ]] && rm -rf "$TMP_WORK"; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------- release ----
if [[ -z $RELEASE_ARG ]]; then
	RELEASE_ARG=$(dirname "$SCRIPT_DIR")
fi
if [[ -f $RELEASE_ARG ]]; then
	TMP_WORK=$(mktemp -d)
	log "Unpacking $RELEASE_ARG"
	tar -xzf "$RELEASE_ARG" -C "$TMP_WORK"
	shopt -s nullglob
	unpacked=("$TMP_WORK"/*/)
	shopt -u nullglob
	[[ ${#unpacked[@]} -eq 1 ]] || die "expected exactly one top-level directory in $RELEASE_ARG"
	SRC=${unpacked[0]%/}
else
	SRC=$(cd "$RELEASE_ARG" 2>/dev/null && pwd) || die "release directory not found: $RELEASE_ARG"
fi

for f in VERSION bin/qatlas web/index.html runner/dist/main.js runner/package.json \
	runner/package-lock.json deploy/systemd/qatlas-server.service deploy/qatlas.env.example; do
	[[ -e $SRC/$f ]] || die "$SRC is not a QAtlas release (missing $f). Build one with \`make release\`."
done
VERSION=$(tr -d '[:space:]' <"$SRC/VERSION")
[[ $VERSION =~ ^[A-Za-z0-9._+-]+$ ]] || die "invalid VERSION in release: '$VERSION'"

# ----------------------------------------------------------------- checks ----
if [[ -r /etc/os-release ]]; then
	# Subshell: os-release defines VERSION, NAME, … which must not leak into this script.
	# shellcheck disable=SC1091
	os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
	case "$os_id" in
	debian | ubuntu) ;;
	*) warn "untested OS '${os_id:-unknown}'; Playwright --with-deps supports Debian 12 and Ubuntu 22.04/24.04" ;;
	esac
fi
command -v systemctl >/dev/null || die "systemd is required"
command -v node >/dev/null || die "Node.js >= $MIN_NODE_MAJOR is required (Debian/Ubuntu ship an older one; see deploy/README.md, NodeSource)"
command -v npm >/dev/null || die "npm is required (comes with the NodeSource nodejs package)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ $NODE_MAJOR -ge $MIN_NODE_MAJOR ]] || die "Node.js >= $MIN_NODE_MAJOR required, found $(node --version)"
NODE_BIN=$(command -v node)
case "$NODE_BIN" in
/usr/bin/* | /usr/local/bin/*) ;;
*) warn "node is at $NODE_BIN; the units call \`node\` via the default PATH (/usr/local/bin:/usr/bin) — install it system-wide or override QATLAS_RUNNER_CMD with an absolute path" ;;
esac

if [[ -z $MODE ]]; then
	if [[ -r $MODE_FILE ]]; then MODE=$(tr -d '[:space:]' <"$MODE_FILE"); else MODE=split; fi
fi
case "$MODE" in
split) UNITS=(qatlas-server.service qatlas-worker.service) ;;
all) UNITS=(qatlas.service) ;;
server) UNITS=(qatlas-server.service) ;;
worker) UNITS=(qatlas-worker.service) ;;
*) die "invalid --mode '$MODE' (split|all|server|worker)" ;;
esac
ALL_UNITS=(qatlas-server.service qatlas-worker.service qatlas.service)
needs_runner=1
[[ $MODE == server ]] && needs_runner=0

log "Installing QAtlas $VERSION (mode: $MODE) from $SRC"

# ------------------------------------------------------ user + directories ---
if ! getent passwd "$SVC_USER" >/dev/null; then
	log "Creating system user $SVC_USER"
	useradd --system --user-group --home-dir "$DATA" --no-create-home \
		--shell /usr/sbin/nologin --comment "QAtlas" "$SVC_USER"
fi
install -d -m 0755 -o root -g root "$PREFIX" "$RELEASES" "$BROWSERS"
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"

# ------------------------------------------------------------- env file ------
if [[ ! -e $ENV_FILE ]]; then
	log "Writing $ENV_FILE (new master key generated)"
	key=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
	(
		umask 027
		sed "s|^QATLAS_MASTER_KEY=.*|QATLAS_MASTER_KEY=$key|" "$SRC/deploy/qatlas.env.example" >"$ENV_FILE"
	)
	chown root:"$SVC_USER" "$ENV_FILE"
	chmod 0640 "$ENV_FILE"
fi
if grep -Eq '^[A-Z_]+=.*CHANGE_ME' "$ENV_FILE"; then
	cat >&2 <<EOF

$ENV_FILE still contains CHANGE_ME placeholders:
$(grep -En '^[A-Z_]+=.*CHANGE_ME' "$ENV_FILE" | sed 's/=.*/=…/' | sed 's/^/  line /')

Fill them in (database URL, base URL; QATLAS_MASTER_KEY was generated for you —
back it up now), then run this script again. Nothing else was changed.
EOF
	exit 2
fi

# ------------------------------------------------------------ release copy ---
DEST=$RELEASES/$VERSION
STAGE=$(mktemp -d "$RELEASES/.$VERSION.XXXXXX")
trap 'rm -rf "$STAGE"; cleanup' EXIT
log "Copying release to $DEST"
cp -a "$SRC/." "$STAGE/"
chown -R root:root "$STAGE"
chmod 0755 "$STAGE" "$STAGE/bin/qatlas"
chmod -R a+rX,go-w "$STAGE"

if [[ $needs_runner -eq 1 ]]; then
	log "Installing runner dependencies (npm ci --omit=dev)"
	(cd "$STAGE/runner" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
	if [[ $SKIP_BROWSERS -eq 0 ]]; then
		log "Installing Playwright browsers + OS deps: $BROWSER_LIST → $BROWSERS"
		# shellcheck disable=SC2086 # word splitting of the browser list is intended
		(cd "$STAGE/runner" && PLAYWRIGHT_BROWSERS_PATH=$BROWSERS ./node_modules/.bin/playwright install --with-deps $BROWSER_LIST)
		chmod -R a+rX "$BROWSERS"
	fi
fi

# Swap the staged copy into place (re-installing the same version replaces it).
if [[ -e $DEST ]]; then
	rm -rf "$DEST.old"
	mv "$DEST" "$DEST.old"
fi
mv "$STAGE" "$DEST"
rm -rf "$DEST.old"
trap cleanup EXIT

# ------------------------------------------------------- units + wrapper -----
log "Installing systemd units"
for u in "${ALL_UNITS[@]}"; do
	install -m 0644 -o root -g root "$DEST/deploy/systemd/$u" "$UNIT_DIR/$u"
done
systemctl daemon-reload

# `sudo qatlas <cmd>` runs the current binary as the service user with the same
# environment as the units (e.g. `sudo qatlas user create-admin --email … --name …`).
cat >"$WRAPPER" <<'EOF'
#!/bin/sh
# Installed by QAtlas deploy/install.sh. Runs /opt/qatlas/current/bin/qatlas as
# user qatlas with /etc/qatlas/qatlas.env (systemd EnvironmentFile semantics).
[ "$(id -u)" -eq 0 ] || { echo "run as root: sudo qatlas $*" >&2; exit 1; }
if [ -t 0 ] && [ -t 1 ]; then io=--pty; else io=--pipe; fi
exec systemd-run --quiet --wait --collect "$io" \
	--uid=qatlas --gid=qatlas \
	-p WorkingDirectory=/var/lib/qatlas \
	-E HOME=/var/lib/qatlas \
	-E QATLAS_DATA_DIR=/var/lib/qatlas \
	-E QATLAS_WEB_DIR=/opt/qatlas/current/web \
	-E "QATLAS_RUNNER_CMD=node /opt/qatlas/current/runner/dist/main.js" \
	-E PLAYWRIGHT_BROWSERS_PATH=/opt/qatlas/ms-playwright \
	-p EnvironmentFile=/etc/qatlas/qatlas.env \
	/opt/qatlas/current/bin/qatlas "$@"
EOF
chmod 0755 "$WRAPPER"

# ------------------------------------------------------------- migrations ----
if [[ $SKIP_MIGRATE -eq 0 && $MODE != worker ]]; then
	log "Running database migrations with $VERSION"
	systemd-run --quiet --wait --collect --pipe \
		--uid="$SVC_USER" --gid="$SVC_USER" \
		-p WorkingDirectory="$DATA" -p EnvironmentFile="$ENV_FILE" \
		"$DEST/bin/qatlas" migrate up </dev/null ||
		die "migrations failed; /opt/qatlas/current was NOT switched (check QATLAS_DATABASE_URL in $ENV_FILE)"
fi

# ------------------------------------------------------- switch current ------
old_target=""
[[ -L $PREFIX/current ]] && old_target=$(readlink "$PREFIX/current")
new_target=releases/$VERSION
if [[ $old_target != "$new_target" ]]; then
	ln -sfn "$new_target" "$PREFIX/current.new"
	mv -Tf "$PREFIX/current.new" "$PREFIX/current"
	if [[ -n $old_target ]]; then
		ln -sfn "$old_target" "$PREFIX/previous.new"
		mv -Tf "$PREFIX/previous.new" "$PREFIX/previous"
	fi
	log "current → $new_target${old_target:+ (previous → $old_target)}"
fi
printf '%s\n' "$MODE" >"$MODE_FILE"

# ----------------------------------------------------------------- services --
for u in "${ALL_UNITS[@]}"; do
	keep=0
	for w in "${UNITS[@]}"; do [[ $u == "$w" ]] && keep=1; done
	if [[ $keep -eq 0 ]] && systemctl is-enabled --quiet "$u" 2>/dev/null; then
		log "Disabling $u (not part of mode $MODE)"
		systemctl disable --now "$u"
	fi
done
systemctl enable --quiet "${UNITS[@]}"
if [[ $NO_START -eq 0 ]]; then
	log "Restarting ${UNITS[*]}"
	systemctl restart "${UNITS[@]}"
	if [[ $MODE != worker ]] && command -v curl >/dev/null; then
		addr=$(sed -n 's/^QATLAS_HTTP_ADDR=//p' "$ENV_FILE" | tail -1)
		port=${addr##*:}
		port=${port:-8090}
		ok=0
		for _ in $(seq 1 30); do
			if curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null; then ok=1; break; fi
			sleep 1
		done
		if [[ $ok -eq 1 ]]; then
			log "Healthy: http://127.0.0.1:$port/healthz"
		else
			warn "server did not answer /healthz on :$port within 30 s — journalctl -u ${UNITS[0]} -n 100"
		fi
	fi
	for u in "${UNITS[@]}"; do
		systemctl is-active --quiet "$u" || warn "$u is not active — journalctl -u $u -n 100"
	done
else
	log "--no-start: services enabled but not restarted"
fi

# ------------------------------------------------------------------ prune -----
keep_targets=("$(readlink "$PREFIX/current" 2>/dev/null || true)" "$(readlink "$PREFIX/previous" 2>/dev/null || true)")
mapfile -t all_releases < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-)
count=0
for r in "${all_releases[@]}"; do
	count=$((count + 1))
	[[ $count -le $KEEP ]] && continue
	protected=0
	for k in "${keep_targets[@]}"; do [[ $k == "releases/$r" ]] && protected=1; done
	if [[ $protected -eq 0 ]]; then
		log "Pruning old release $r"
		rm -rf "${RELEASES:?}/$r"
	fi
done

cat <<EOF

QAtlas $VERSION installed (mode: $MODE).
  config:    $ENV_FILE   (back up QATLAS_MASTER_KEY!)
  data:      $DATA
  status:    systemctl status ${UNITS[*]}
  logs:      journalctl -u ${UNITS[0]} -f
  first run: sudo qatlas user create-admin --email you@example.com --name "Your Name"
  rollback:  sudo $PREFIX/current/deploy/rollback.sh
EOF
