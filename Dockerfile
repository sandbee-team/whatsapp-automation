# syntax=docker/dockerfile:1.7
#
# Production image for the WP backend (2026-09-14).
#
# ONE image, FIVE processes. `ROLE` selects which (MASTER-PLAN S2.1):
#   ROLE=api | session-worker | cron | relay | migrate
# That is the shape `app/backend/src/main.ts` already dispatches, so the image
# adds no new entrypoint concept - it just runs the compiled version of it.
#
# WHY COMPILED, NOT tsx (this is the whole point of the file):
# The dev stack runs `pnpm exec tsx src/main.ts` with the repo bind-mounted.
# That is not a deploy shape: it ships the TypeScript sources, the dev
# toolchain and the test tree to production. This image instead runs
# `node dist/main.js`. Three things had to be true for that to work, and all
# three were verified before this file was written:
#
#   1. Workspace packages must resolve to COMPILED js. Every `@wp/*` package
#      used to export `./src/*.ts`, so compiled code still imported TypeScript
#      and Node died with `Unknown file extension ".ts"`. They now declare
#      conditional exports whose `default` is `./dist/*.js`.
#   2. The 8 Lua scripts under `app/backend/src/**/scripts/` are read with
#      `readFileSync` at MODULE LOAD time, so a missing one crashes the
#      process at import, not at first use. `tsc` does not copy them, so this
#      image copies them explicitly (see the `assets` stage).
#   3. `db/queries/*.sql` (112 files) and `db/migrations/*.sql` (77 files) are
#      read at runtime relative to the package directory. `db/src` and
#      `db/dist` sit at the same depth, so `../queries` resolves identically
#      either way - but both directories must be PRESENT in the image.
#
# Build from the repo root:  docker build -t wp-backend:<tag> .

# ---------------------------------------------------------------------------
# Stage 1: deps - install the full workspace, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:24.19.0-bookworm-slim AS deps
WORKDIR /repo

# corepack pins pnpm from package.json#packageManager, so the image and the dev
# box use the SAME pnpm. `use-node-version` in the repo .npmrc would make pnpm
# download a second Node runtime inside a container that already has the right
# one, so it is neutralised here rather than edited in the repo (the dev box
# still wants it).
# CI=true: pnpm refuses to purge an existing node_modules directory without a
# TTY (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`), which is exactly what the
# --prod reinstall below does. A Docker build has no TTY, so this is required,
# not cosmetic.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    npm_config_use_node_version=

RUN corepack enable

# Only the manifests, so a source-only edit does not invalidate the install
# layer. Every workspace package.json must be listed: pnpm resolves the whole
# graph before it installs anything.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY app/backend/package.json        app/backend/package.json
COPY app/frontend/package.json       app/frontend/package.json
COPY admin/backend/package.json      admin/backend/package.json
COPY admin/frontend/package.json     admin/frontend/package.json
COPY website/package.json            website/package.json
COPY db/package.json                 db/package.json
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/domain/package.json    packages/domain/package.json
COPY packages/i18n/package.json      packages/i18n/package.json
COPY packages/server-kit/package.json packages/server-kit/package.json
COPY packages/testkit/package.json   packages/testkit/package.json
COPY packages/ui/package.json        packages/ui/package.json
COPY packages/utils/package.json     packages/utils/package.json

# --frozen-lockfile: the lockfile is the contract; a drifted manifest fails the
# build instead of silently resolving something else.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: build - compile TypeScript to dist/
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo

COPY packages/ packages/
COPY db/ db/
COPY app/backend/ app/backend/
COPY admin/backend/ admin/backend/
# app/backend/tsconfig.json REFERENCES scripts/{chaos,measure,ops,loadtest},
# and `app/backend/src/engine/measure/**` really does import from them, so the
# build needs their sources even though none of them is a workspace package
# and none is reachable from a running role.
COPY scripts/ scripts/

# Two steps, because the frontends and the test tree are both absent here.
#
# 1. `tsc -b` on the five LIBRARY projects only. NOT `pnpm run build`, which
#    builds the ROOT tsconfig and therefore also app/frontend, admin/frontend
#    and website - none of which exists in this image (the three frontends are
#    static bundles served by the edge, not part of a backend image).
# 2. Each backend via its own `tsconfig.build.json`, which excludes the test
#    tree and the `engine/measure/**` harnesses. Those harnesses are NOT tests
#    but they import from `__tests__/`, which `.dockerignore` excludes, so the
#    ordinary tsconfig cannot compile here. Verified safe by walking all five
#    ROLE entrypoints' import graphs: 995 reachable modules, zero of them a
#    measurement or test-support module.
RUN pnpm exec tsc -b packages/config packages/utils packages/domain packages/contracts db packages/server-kit \
 && pnpm exec tsc -p app/backend/tsconfig.build.json \
 && pnpm exec tsc -p admin/backend/tsconfig.build.json

# The 8 Lua scripts are loaded with readFileSync at module scope and tsc does
# NOT copy them. Without this the session-worker dies at import with
# `ENOENT ... dist/engine/lease/scripts/acquire.lua`. Verified empirically.
RUN set -eu; \
    cd /repo/app/backend; \
    find src -name '*.lua' -exec sh -c 'for f; do \
        d="dist/${f#src/}"; mkdir -p "$(dirname "$d")"; cp "$f" "$d"; \
      done' sh {} +; \
    echo "lua copied: $(find dist -name '*.lua' | wc -l) (expected 8)"; \
    test "$(find dist -name '*.lua' | wc -l)" -eq 8

# ---------------------------------------------------------------------------
# Stage 3: prod-deps - production-only node_modules
# ---------------------------------------------------------------------------
FROM node:24.19.0-bookworm-slim AS prod-deps
WORKDIR /repo
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true \
    npm_config_use_node_version=
RUN corepack enable

# A FRESH base, not `FROM deps`. Inheriting `deps` would carry its already
# populated node_modules, and a filtered reinstall does not evict what is
# already linked there - measured: next (202 MB), @next/swc (93 MB),
# lucide-react (44 MB), typescript (24 MB), lighthouse (21 MB) all survived and
# the image stayed at 1.07 GB. Installing into an empty tree is what actually
# keeps the frontend out.
#
# `--filter <pkg>...` resolves each backend PLUS its workspace dependencies and
# nothing else; `--prod` drops devDependencies, which the runtime never needs
# because it runs compiled JS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY app/backend/package.json        app/backend/package.json
COPY app/frontend/package.json       app/frontend/package.json
COPY admin/backend/package.json      admin/backend/package.json
COPY admin/frontend/package.json     admin/frontend/package.json
COPY website/package.json            website/package.json
COPY db/package.json                 db/package.json
COPY packages/config/package.json    packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/domain/package.json    packages/domain/package.json
COPY packages/i18n/package.json      packages/i18n/package.json
COPY packages/server-kit/package.json packages/server-kit/package.json
COPY packages/testkit/package.json   packages/testkit/package.json
COPY packages/ui/package.json        packages/ui/package.json
COPY packages/utils/package.json     packages/utils/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --prod --ignore-scripts=false \
      --filter app-backend... --filter admin-backend...

# ---------------------------------------------------------------------------
# Stage 4: runtime
# ---------------------------------------------------------------------------
FROM node:24.19.0-bookworm-slim AS runtime
WORKDIR /repo

# tini reaps zombies and forwards SIGTERM, which this app depends on: every
# role installs its own SIGTERM handler for graceful shutdown, and the
# session-worker is given a 45s stop grace period to drain in-flight sends.
# Without a real init, PID 1 semantics swallow that signal.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    ROLE=api \
    PORT=3000

# Non-root. The app writes nothing to the image filesystem in production
# (OBJECT_STORE_DRIVER=s3), so the tree stays read-only to the runtime user.
RUN groupadd --system --gid 1001 wp \
 && useradd  --system --uid 1001 --gid wp --home-dir /repo --shell /usr/sbin/nologin wp

# pnpm is NOT flat: each workspace package gets its OWN node_modules holding
# symlinks into the root .pnpm store, and a package's dependencies are ONLY
# resolvable through it. Missing one is not a size saving, it is a crash -
# omitting packages/server-kit/node_modules produced exactly
# `Cannot find package 'zod' imported from
# /repo/packages/server-kit/dist/config/schema.js` at API boot. Every workspace
# package that ships dist/ therefore ships its node_modules too.
COPY --from=prod-deps --chown=root:root /repo/node_modules                   ./node_modules
COPY --from=prod-deps --chown=root:root /repo/app/backend/node_modules       ./app/backend/node_modules
COPY --from=prod-deps --chown=root:root /repo/admin/backend/node_modules     ./admin/backend/node_modules
COPY --from=prod-deps --chown=root:root /repo/db/node_modules                ./db/node_modules
COPY --from=prod-deps --chown=root:root /repo/packages/server-kit/node_modules ./packages/server-kit/node_modules
COPY --from=prod-deps --chown=root:root /repo/packages/domain/node_modules   ./packages/domain/node_modules
COPY --from=prod-deps --chown=root:root /repo/packages/contracts/node_modules ./packages/contracts/node_modules

# Manifests carry the conditional `exports` maps that make `@wp/*` resolve to
# dist/*.js - without them Node cannot resolve a workspace import at all.
COPY --from=build --chown=root:root /repo/package.json         ./package.json
COPY --from=build --chown=root:root /repo/pnpm-workspace.yaml  ./pnpm-workspace.yaml

# Only what a running role reads: each package's compiled dist/ and its
# package.json (the exports map). NOT src/ - shipping TypeScript sources to
# production is the thing this image exists to stop, and `node` never reads
# them once `exports` points at dist/.
COPY --from=build --chown=root:root /repo/packages/config/package.json      ./packages/config/package.json
COPY --from=build --chown=root:root /repo/packages/utils/package.json       ./packages/utils/package.json
COPY --from=build --chown=root:root /repo/packages/utils/dist               ./packages/utils/dist
COPY --from=build --chown=root:root /repo/packages/domain/package.json      ./packages/domain/package.json
COPY --from=build --chown=root:root /repo/packages/domain/dist              ./packages/domain/dist
COPY --from=build --chown=root:root /repo/packages/contracts/package.json   ./packages/contracts/package.json
COPY --from=build --chown=root:root /repo/packages/contracts/dist           ./packages/contracts/dist
COPY --from=build --chown=root:root /repo/packages/server-kit/package.json  ./packages/server-kit/package.json
COPY --from=build --chown=root:root /repo/packages/server-kit/dist          ./packages/server-kit/dist

# db ships its dist AND its two SQL directories: `db/src/queries.ts` resolves
# `../queries` relative to its own package dir, and ROLE=migrate resolves
# `db/migrations` from the repo root. Both are read at runtime.
COPY --from=build --chown=root:root /repo/db/package.json ./db/package.json
COPY --from=build --chown=root:root /repo/db/dist         ./db/dist
COPY --from=build --chown=root:root /repo/db/queries      ./db/queries
COPY --from=build --chown=root:root /repo/db/migrations   ./db/migrations

COPY --from=build --chown=root:root /repo/app/backend/package.json   ./app/backend/package.json
COPY --from=build --chown=root:root /repo/app/backend/dist           ./app/backend/dist
COPY --from=build --chown=root:root /repo/admin/backend/package.json ./admin/backend/package.json
COPY --from=build --chown=root:root /repo/admin/backend/dist         ./admin/backend/dist

WORKDIR /repo/app/backend
USER wp

# /metrics stays on loopback: `startMetricsServer` REFUSES an all-interfaces
# bind in production. Scrape it from the host, never publish this port.
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
