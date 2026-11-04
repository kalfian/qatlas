#!/usr/bin/env bash
# QAtlas rollback for manual (systemd) installs: points /opt/qatlas/current back
# at an earlier release in /opt/qatlas/releases and restarts the services.
#
#   sudo /opt/qatlas/current/deploy/rollback.sh            # back to /opt/qatlas/previous
#   sudo /opt/qatlas/current/deploy/rollback.sh 0.3.1      # a specific release
#   sudo /opt/qatlas/current/deploy/rollback.sh --list
#
# The database is NOT rolled back. Releases are expected to be backward compatible
# with the schema of the next release; if the newer release added a migration the
# old one cannot live with, restore the pg_dump taken before the upgrade (or run
# `sudo qatlas migrate down` once per migration, *before* rolling back, while the
# newer binary that knows the migration is still current).
set -Eeuo pipefail

PREFIX=/opt/qatlas
RELEASES=$PREFIX/releases
MODE_FILE=/etc/qatlas/install-mode

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

current=$(readlink "$PREFIX/current" 2>/dev/null || true)
previous=$(readlink "$PREFIX/previous" 2>/dev/null || true)

list() {
	echo "Releases in $RELEASES (newest first):"
	find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2- |
		while read -r r; do
			mark=""
			[[ "releases/$r" == "$current" ]] && mark=" (current)"
			[[ "releases/$r" == "$previous" ]] && mark="$mark (previous)"
			echo "  $r$mark"
		done
}

case "${1:-}" in
-h | --help)
	sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
	;;
--list)
	list
	exit 0
	;;
esac

[[ $EUID -eq 0 ]] || die "run as root"
[[ -n $current ]] || die "$PREFIX/current does not exist — nothing is installed"

if [[ -n ${1:-} ]]; then
	[[ $1 =~ ^[A-Za-z0-9._+-]+$ ]] || die "invalid version '$1'"
	target=releases/$1
else
	[[ -n $previous ]] || die "no $PREFIX/previous recorded; pass a version (see --list)"
	target=$previous
fi
[[ -x $PREFIX/$target/bin/qatlas ]] || die "$PREFIX/$target is not an installed release (see --list)"
[[ $target != "$current" ]] || die "$target is already current"

log "Switching current: $current → $target"
ln -sfn "$target" "$PREFIX/current.new"
mv -Tf "$PREFIX/current.new" "$PREFIX/current"
ln -sfn "$current" "$PREFIX/previous.new"
mv -Tf "$PREFIX/previous.new" "$PREFIX/previous"

mode=split
[[ -r $MODE_FILE ]] && mode=$(tr -d '[:space:]' <"$MODE_FILE")
case "$mode" in
split) units=(qatlas-server.service qatlas-worker.service) ;;
all) units=(qatlas.service) ;;
server) units=(qatlas-server.service) ;;
worker) units=(qatlas-worker.service) ;;
*) die "unknown mode '$mode' in $MODE_FILE" ;;
esac

# Units of the target release (they may differ between versions).
if [[ -d $PREFIX/$target/deploy/systemd ]]; then
	install -m 0644 -o root -g root "$PREFIX/$target"/deploy/systemd/*.service /etc/systemd/system/
	systemctl daemon-reload
fi

log "Restarting ${units[*]}"
systemctl restart "${units[@]}"
sleep 2
for u in "${units[@]}"; do
	systemctl is-active --quiet "$u" || warn "$u is not active — journalctl -u $u -n 100"
done
log "Rolled back to ${target#releases/} (undo with: $0 ${current#releases/})"
warn "database migrations were not rolled back (see the header of this script)"
