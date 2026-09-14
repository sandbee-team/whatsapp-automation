#!/usr/bin/env bash
#
# build-frontends.sh (2026-09-15) - build the two SPAs (app/frontend,
# admin/frontend) that the edge serves, and package them into a tarball for
# ship-frontends.sh. website/ is deliberately NOT built here - it is out of
# scope for the Caddy edge this round (see infra/nginx/README.md and the
# Caddyfile, which serve app.<domain> and admin.<domain> only).
#
#   ./infra/deploy/build-frontends.sh              # tag from the date
#   ./infra/deploy/build-frontends.sh v3           # explicit tag
#
# Run it from the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TAG="${1:-$(date +%Y%m%d-%H%M)}"

# Same convention as build-image.sh's OUT_DIR, and for the same two reasons:
#   1. `scripts/check-tree.ts` enforces the ADR 0014 top-level tree, and a new
#      root directory like `.deploy/` fails the gate.
#   2. Build output does not belong inside the workspace tree, where it would
#      bloat backups and (for app/frontend, admin/frontend) get swept up by
#      any future full-tree scan.
OUT_DIR="${OUT_DIR:-$(dirname "$REPO_ROOT")/wp-deploy-artifacts}"
TARBALL="${OUT_DIR}/wp-frontends-${TAG}.tar"

# --------------------------------------------------------------------------
# Build the workspace packages the two SPAs import at build time.
#
# Neither SPA can `vite build` on its own: both import `@wp/ui`, `@wp/domain`,
# `@wp/contracts`, `@wp/utils` and (admin only) `@wp/i18n` as workspace
# packages whose `exports` map points at compiled `dist/*.js`
# (packages/*/package.json's conditional `exports`, same mechanism the
# Dockerfile's comment block explains for the backends) - Vite resolves the
# `default` condition, never the `wp-source` one vitest uses, so an unbuilt
# package fails as `Cannot find module '.../dist/index.js'`, not as a
# TypeScript error.
#
# Two separate steps, because they use two different toolchains:
#   1. `tsc -b` (root `pnpm run build`) compiles every COMPOSITE project
#      reference from the root tsconfig.json - packages/config, utils,
#      domain, contracts, i18n, ui, server-kit, and db - which covers every
#      `@wp/*` package the two frontends import EXCEPT design-tokens (below).
#      This is NOT `domain:browser-build` (that esbuild bundle is a CI purity
#      proof that @wp/domain has no Node-only imports - scripts/ci-steps.ts
#      calls it "proves @wp/domain is runtime-agnostic" - it is never what
#      `exports.default` points at, so nothing consumes its output here).
#   2. `tokens:build` (packages/design-tokens/build.mjs, via style-dictionary)
#      generates the CSS files `@wp/design-tokens/tokens.css` and
#      `.../tailwind.css` resolve to. Neither frontend's tailwind.css entry
#      point (`@import '@wp/design-tokens/tokens.css'`) would resolve without
#      this - it is not part of `tsc -b` because design-tokens has no
#      TypeScript build step of its own for its CSS output.
echo "==> building workspace packages (tsc -b)"
pnpm run build

echo
echo "==> building design tokens (tokens:build)"
pnpm run tokens:build

# --------------------------------------------------------------------------
# Build the two SPAs.
# --------------------------------------------------------------------------
echo
echo "==> building app-frontend"
pnpm -F app-frontend run build

echo
echo "==> building admin-frontend"
pnpm -F admin-frontend run build

APP_DIST="${REPO_ROOT}/app/frontend/dist"
ADMIN_DIST="${REPO_ROOT}/admin/frontend/dist"

for d in "$APP_DIST" "$ADMIN_DIST"; do
  [ -f "${d}/index.html" ] || {
    echo "FAILED - ${d}/index.html is missing; the build above did not produce a usable SPA" >&2
    exit 1
  }
done

# --------------------------------------------------------------------------
# Package both dist/ trees into one tarball, each under its own top-level
# directory so ship-frontends.sh can rsync them straight into the two host
# paths the Caddyfile mounts (WP_APP_FRONTEND_DIR / WP_ADMIN_FRONTEND_DIR in
# docker-compose.prod.yml).
# --------------------------------------------------------------------------
echo
echo "==> packaging ${TARBALL}"
mkdir -p "${OUT_DIR}"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

mkdir -p "${STAGE_DIR}/app" "${STAGE_DIR}/admin"
cp -a "${APP_DIST}/." "${STAGE_DIR}/app/"
cp -a "${ADMIN_DIST}/." "${STAGE_DIR}/admin/"

tar -cf "${TARBALL}" -C "${STAGE_DIR}" app admin
gzip -f "${TARBALL}"
ls -lh "${TARBALL}.gz"

echo
echo "Done. Ship it with:"
echo "  ./infra/deploy/ship-frontends.sh <user@host> ${TAG}"
