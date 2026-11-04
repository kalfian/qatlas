#!/usr/bin/env bash
# Download the pinned Mailpit release (https://github.com/axllent/mailpit) once into DIR and print
# the binary path. Used by scripts/demo-server.sh and scripts/e2e-real.sh for the demo shop's
# sign-up emails. The release publishes no checksum file, so the SHA-256 of each release asset
# (GitHub's asset digest) is pinned here; a mismatch aborts without installing anything.
#
#   scripts/fetch-mailpit.sh DIR        → DIR/mailpit (downloaded only if missing or another version)
#
# To upgrade: change MAILPIT_VERSION and both digests (gh api repos/axllent/mailpit/releases/latest
# shows them as "digest" per asset).
set -euo pipefail

MAILPIT_VERSION="v1.33.0"
declare -A MAILPIT_SHA256=(
  [linux-amd64]=d0ec50080cbf3e7c1fa2cda2ee68125d7894175811084b1f8f47c6cfc6f487c8
  [linux-arm64]=1d27c819e1a5dd2761ed9fd07022443e35a47793b2e92de5b49cf3656a649ef9
)

dir="${1:?usage: $0 DIR}"
bin="$dir/mailpit"
if [[ -x $bin ]] && [[ "$("$bin" version 2>/dev/null | awk '{print $2}')" == "$MAILPIT_VERSION" ]]; then
  echo "$bin"
  exit 0
fi

case "$(uname -m)" in
  x86_64 | amd64) arch=linux-amd64 ;;
  aarch64 | arm64) arch=linux-arm64 ;;
  *) echo "no pinned Mailpit build for $(uname -m)" >&2; exit 1 ;;
esac
url="https://github.com/axllent/mailpit/releases/download/$MAILPIT_VERSION/mailpit-$arch.tar.gz"

mkdir -p "$dir"
dl="$(mktemp -d "$dir/.download.XXXXXX")"
trap 'rm -rf "$dl"' EXIT
echo "downloading Mailpit $MAILPIT_VERSION ($arch)" >&2
curl -fsSL -o "$dl/mailpit.tar.gz" "$url" || { echo "download failed: $url" >&2; exit 1; }
if ! echo "${MAILPIT_SHA256[$arch]}  $dl/mailpit.tar.gz" | sha256sum -c --quiet - >&2; then
  echo "Mailpit checksum mismatch for $url — not installed" >&2
  exit 1
fi
tar -xzf "$dl/mailpit.tar.gz" -C "$dl" mailpit
install -m 0755 "$dl/mailpit" "$bin"
echo "$bin"
