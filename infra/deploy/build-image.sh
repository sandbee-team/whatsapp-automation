#!/usr/bin/env bash
#
# build-image.sh (2026-09-14) - build, scan and save the production image.
#
# This is step 1-2 of the deploy shape in infra/deploy/README.md. There is no
# git host and no CI runner (ADR 0003): the image is built here, scanned here,
# and shipped as a tarball over SSH by ship-image.sh.
#
#   ./infra/deploy/build-image.sh              # tag from the date, scan, save
#   ./infra/deploy/build-image.sh v3           # explicit tag
#   SKIP_SCAN=1 ./infra/deploy/build-image.sh  # skip trivy (NOT for a real deploy)
#
# Run it from the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TAG="${1:-$(date +%Y%m%d-%H%M)}"
IMAGE="wp-backend:${TAG}"

# OUTSIDE the repo, deliberately. Two reasons:
#   1. `scripts/check-tree.ts` enforces the ADR 0014 top-level tree, and a new
#      root directory like `.deploy/` fails the gate. Verified: it does.
#   2. These tarballs are ~350 MB each and would otherwise accumulate inside
#      the workspace, bloating every backup and every docker build context.
OUT_DIR="${OUT_DIR:-$(dirname "$REPO_ROOT")/wp-deploy-artifacts}"
TARBALL="${OUT_DIR}/wp-backend-${TAG}.tar"

echo "==> building ${IMAGE}"
docker build -t "${IMAGE}" -t "wp-backend:latest" .

echo
echo "==> image size"
docker image ls "${IMAGE}" --format '{{.Repository}}:{{.Tag}}  {{.Size}}'

# A smoke test, not a formality: it catches the failure mode this image was
# built to avoid - a role that cannot even resolve its own imports. Reaching
# the config check means the whole compiled graph loaded, including the Lua
# scripts and the SQL directories.
echo
echo "==> smoke: the image must reach its own config validation"
if docker run --rm -e NODE_ENV=production "${IMAGE}" 2>&1 \
     | grep -q 'AUTH_JWT_SECRET is required in production'; then
  echo "    ok - compiled graph loads and config fails closed as designed"
else
  echo "    FAILED - the image did not reach config validation." >&2
  echo "    Run: docker run --rm -e NODE_ENV=production ${IMAGE}" >&2
  exit 1
fi

# The same pinned trivy the gate uses, now pointed at the built image. A
# scanner that cannot run FAILS the deploy; it is never an implicit pass.
if [ "${SKIP_SCAN:-0}" != "1" ]; then
  echo
  echo "==> trivy scan of the image (HIGH,CRITICAL)"
  # Tag AND digest - the exact pin scripts/guards/security-scan-runner.ts
  # uses for the gate's own filesystem scan. Keep the two in sync.
  TRIVY_IMAGE='aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7'
  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${REPO_ROOT}/infra/deploy/trivy.yaml:/trivy.yaml:ro" \
    "${TRIVY_IMAGE}" image \
      --config /trivy.yaml \
      --severity HIGH,CRITICAL \
      --exit-code 1 \
      "${IMAGE}"
  echo "    ok - no HIGH/CRITICAL findings"
else
  echo
  echo "==> trivy SKIPPED (SKIP_SCAN=1) - do not ship this to production"
fi

echo
echo "==> saving ${TARBALL}"
mkdir -p "${OUT_DIR}"
docker save "${IMAGE}" -o "${TARBALL}"
gzip -f "${TARBALL}"
ls -lh "${TARBALL}.gz"

echo
echo "Done. Ship it with:"
echo "  ./infra/deploy/ship-image.sh <user@host> ${TAG}"
