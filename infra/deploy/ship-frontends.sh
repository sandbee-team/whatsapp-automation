#!/usr/bin/env bash
#
# ship-frontends.sh (2026-09-15) - copy the built SPA tarball to the EC2 box,
# unpack it into the two paths Caddy serves from, and reload Caddy so it
# picks up the new files. Companion to ship-image.sh; run build-frontends.sh
# first (ADR 0003: rsync over SSH, never a git-based artifact transfer).
#
#   ./infra/deploy/ship-frontends.sh ubuntu@1.2.3.4 20260915-1830
#
# What it does on the remote, in order:
#   1. unpack app/ and admin/ from the tarball into WP_APP_FRONTEND_DIR and
#      WP_ADMIN_FRONTEND_DIR (must match the values in /opt/wp/.env that
#      docker-compose.prod.yml's `caddy` service mounts read-only)
#   2. `docker compose exec caddy caddy reload` - Caddy re-reads its config
#      and starts serving the new files with NO restart and NO dropped
#      in-flight connections (unlike ship-image.sh's api/cron/relay restart,
#      a reload is enough here because only the static files changed, not
#      the Caddyfile itself)

set -euo pipefail

REMOTE="${1:?usage: ship-frontends.sh <user@host> <tag>}"
TAG="${2:?usage: ship-frontends.sh <user@host> <tag>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Must match build-frontends.sh's OUT_DIR, which lives OUTSIDE the repo so the
# ADR 0014 tree guard stays green.
LOCAL_TARBALL="${OUT_DIR:-$(dirname "$REPO_ROOT")/wp-deploy-artifacts}/wp-frontends-${TAG}.tar.gz"
REMOTE_DIR="${REMOTE_DIR:-/opt/wp}"
COMPOSE="${REMOTE_DIR}/docker-compose.prod.yml"

# Same two paths the `caddy` service in docker-compose.prod.yml mounts
# read-only as /srv/app and /srv/admin - override only if /opt/wp/.env on
# the target box overrides WP_APP_FRONTEND_DIR / WP_ADMIN_FRONTEND_DIR too.
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/opt/wp/frontends/app}"
REMOTE_ADMIN_DIR="${REMOTE_ADMIN_DIR:-/opt/wp/frontends/admin}"

[ -f "$LOCAL_TARBALL" ] || {
  echo "no tarball at $LOCAL_TARBALL - run build-frontends.sh ${TAG} first" >&2
  exit 1
}

echo "==> copying $(basename "$LOCAL_TARBALL") to ${REMOTE}:${REMOTE_DIR}/"
rsync -avP --partial "$LOCAL_TARBALL" "${REMOTE}:${REMOTE_DIR}/"

echo "==> unpacking and reloading caddy on ${REMOTE}"
ssh "${REMOTE}" bash -seu <<REMOTE_SCRIPT
cd "${REMOTE_DIR}"

echo "--> making frontend directories"
mkdir -p "${REMOTE_APP_DIR}" "${REMOTE_ADMIN_DIR}"

echo "--> extracting wp-frontends-${TAG}.tar.gz"
TMP_EXTRACT="\$(mktemp -d)"
tar -xzf "wp-frontends-${TAG}.tar.gz" -C "\${TMP_EXTRACT}"

# rsync --delete so a file removed from a later build (a renamed hashed
# asset, an old chunk) does not linger on disk forever - Caddy's file_server
# would happily keep serving a stale bundle no current index.html references.
echo "--> syncing app/ -> ${REMOTE_APP_DIR}"
rsync -a --delete "\${TMP_EXTRACT}/app/" "${REMOTE_APP_DIR}/"

echo "--> syncing admin/ -> ${REMOTE_ADMIN_DIR}"
rsync -a --delete "\${TMP_EXTRACT}/admin/" "${REMOTE_ADMIN_DIR}/"

rm -rf "\${TMP_EXTRACT}"

echo "--> reloading caddy (no downtime - config + files only, no restart)"
# -T: no pseudo-TTY, matching the non-interactive ssh heredoc this whole
# script runs under (a TTY-requiring exec fails here with "the input device
# is not a TTY").
docker compose -f "${COMPOSE}" exec -T caddy caddy reload --config /etc/caddy/Caddyfile

echo "--> current state"
docker compose -f "${COMPOSE}" ps caddy
REMOTE_SCRIPT

echo
echo "Deployed frontends ${TAG} to ${REMOTE}."
echo "Check: curl -sI https://app.<your-domain>/ | head -1"
echo "       curl -sI https://admin.<your-domain>/ | head -1"
