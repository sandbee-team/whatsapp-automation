#!/usr/bin/env bash
#
# ship-image.sh (2026-09-14) - copy a saved image to the EC2 box, load it and
# restart the services. Steps 3-4 of the deploy shape in this directory's
# README (ADR 0003: rsync over SSH, never a git-based artifact transfer).
#
#   ./infra/deploy/ship-image.sh ubuntu@1.2.3.4 20260914-1830
#
# What it does on the remote, in order:
#   1. load the image tarball
#   2. run migrations to completion (ROLE=migrate, one-shot)
#   3. restart api, cron and relay
#   4. restart session-worker LAST, and only if it was already running
#
# Why the worker is last and conditional: it holds live WhatsApp sockets and
# is given 45s to drain in-flight sends. Restarting it is the most disruptive
# thing in a deploy, and on a box too small to run it (a 1 GB free-tier
# instance) it is deliberately not running at all - this script must not be
# what starts it there.

set -euo pipefail

REMOTE="${1:?usage: ship-image.sh <user@host> <tag>}"
TAG="${2:?usage: ship-image.sh <user@host> <tag>}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Must match build-image.sh's OUT_DIR, which lives OUTSIDE the repo so the
# ADR 0014 tree guard stays green and 350 MB tarballs stay out of the workspace.
LOCAL_TARBALL="${OUT_DIR:-$(dirname "$REPO_ROOT")/wp-deploy-artifacts}/wp-backend-${TAG}.tar.gz"
REMOTE_DIR="${REMOTE_DIR:-/opt/wp}"
COMPOSE="${REMOTE_DIR}/docker-compose.prod.yml"

[ -f "$LOCAL_TARBALL" ] || {
  echo "no tarball at $LOCAL_TARBALL - run build-image.sh ${TAG} first" >&2
  exit 1
}

echo "==> copying $(basename "$LOCAL_TARBALL") to ${REMOTE}:${REMOTE_DIR}/"
rsync -avP --partial "$LOCAL_TARBALL" "${REMOTE}:${REMOTE_DIR}/"

echo "==> copying the compose file"
rsync -av "${REPO_ROOT}/infra/compose/docker-compose.prod.yml" "${REMOTE}:${COMPOSE}"

echo "==> loading and restarting on ${REMOTE}"
ssh "${REMOTE}" bash -seu <<REMOTE_SCRIPT
cd "${REMOTE_DIR}"

echo "--> docker load"
gunzip -c "wp-backend-${TAG}.tar.gz" | docker load

echo "--> retagging wp-backend:${TAG} as wp-backend:latest"
docker tag "wp-backend:${TAG}" wp-backend:latest

echo "--> migrations"
# Must finish before any role that reads the new schema starts.
docker compose -f "${COMPOSE}" --profile tools run --rm migrate

echo "--> restarting api, admin-api, cron, relay"
docker compose -f "${COMPOSE}" up -d --no-deps api admin-api cron relay

# Only restart the worker if it is already running. On a box that cannot fit
# it, it is intentionally absent and must stay that way.
if docker compose -f "${COMPOSE}" ps --services --filter status=running | grep -qx session-worker; then
  echo "--> restarting session-worker (45s drain)"
  docker compose -f "${COMPOSE}" up -d --no-deps session-worker
else
  echo "--> session-worker is not running; leaving it stopped"
fi

echo "--> current state"
docker compose -f "${COMPOSE}" ps
REMOTE_SCRIPT

echo
echo "Deployed ${TAG} to ${REMOTE}."
echo "Check: ssh ${REMOTE} 'docker compose -f ${COMPOSE} logs --tail 50 api'"
