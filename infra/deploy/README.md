# Deploy (P29a launch-hardening Unit U1)

INTERNAL - operational notes for this repo's deploy shape. No figure here is
a customer-facing claim.

## Deploy shape (ADR 0003: no git host)

This repository is not a git repository and must never become one. There is
no GitHub Actions runner, no `git push`-triggered pipeline, and no scanner
here ever runs in a git-aware mode. Deploys are:

1. `docker build` a production image locally / on the build box.
2. `docker save` the image to a tarball.
3. Copy the tarball to the target host over SSH (rsync), never a git-based
   artifact transfer.
4. `docker load` + restart the service on the target host.

**These scripts now exist** (2026-09-14); the note that they would "ship in a
later phase" is obsolete.

| File                                    | What it does                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Dockerfile`                           | One image, five roles. `ROLE=api\|session-worker\|cron\|relay\|migrate` selects the process, exactly as `app/backend/src/main.ts` already dispatches. |
| `/.dockerignore`                        | Keeps `.secrets/` and `demo/` (~450 MB of reference repos) out of the build context.                                                                  |
| `infra/deploy/build-image.sh`           | Builds, smoke-tests, trivy-scans and `docker save`s the image.                                                                                        |
| `infra/deploy/ship-image.sh`            | rsyncs the tarball, loads it, migrates, restarts.                                                                                                     |
| `infra/compose/docker-compose.prod.yml` | Runs the whole product on one box.                                                                                                                    |
| `infra/deploy/wp.env.example`           | Every env var the box needs, with the required ones marked.                                                                                           |

```bash
# The tarball is written OUTSIDE the repo (../wp-deploy-artifacts/): a new
# top-level directory would fail scripts/check-tree.ts, and these are ~350 MB.
./infra/deploy/build-image.sh              # -> ../wp-deploy-artifacts/wp-backend-<tag>.tar.gz
./infra/deploy/ship-image.sh ubuntu@<host> <tag>
```

### The image runs COMPILED JavaScript, never `tsx`

This is the property that makes the image small and the deploy boring, and it
took three fixes to become true. Each was verified by running the image, not by
reading the code:

1. **Workspace packages resolve to `dist/`.** Every `@wp/*` package used to
   export `./src/*.ts`, so compiled code still imported TypeScript and Node
   died with `Unknown file extension ".ts"`. They now declare conditional
   `exports` whose `default` is `./dist/*.js`, plus a `wp-source` condition
   that Vitest uses so **tests still run against source** - without that, the
   whole suite would silently test stale compiled output.
2. **The 8 Lua scripts are copied into `dist/`.** They are read with
   `readFileSync` at module load, so a missing one crashes the process at
   import. `tsc` does not copy non-TS files; the Dockerfile does, and asserts
   the count is 8.
3. **`db/queries` (112 files) and `db/migrations` (77 files) ship as
   directories.** Both are read at runtime. `db/src` and `db/dist` sit at the
   same depth, so the relative paths resolve unchanged - but the directories
   must be present.

Two `tsconfig.build.json` files (one per backend) exclude the test tree and the
`engine/measure/**` harnesses, which import from `__tests__/` and therefore
cannot compile in an image that excludes tests. Walking all five role
entrypoints' import graphs reaches 995 modules and none of them is a
measurement or test-support module, so nothing a running role executes is lost.

Verified end to end on 2026-09-14: `ROLE=migrate` against a real Postgres
reported `applied 0 migration(s), 77 already up to date`, and `ROLE=api` served
`POST /v1/messages`-shaped traffic (`POST /v1/auth/login` with an empty body
returned the correct `VALIDATION_ERROR` envelope). Image size: **352 MB**.

This document covers the security-scanning half below.

## The three pinned security scanners

Every scanner is a pinned Docker image - tag AND digest - never a locally
installed binary, never `curl | sh`, never a language-package-manager
wrapper. See `docs/evidence/P29-security-scans.md` for the exact
`image:tag@sha256:digest` triples and how each was obtained
(`docker pull <image>:<tag>` then `docker image inspect --format
'{{index .RepoDigests 0}}'`).

| Scanner  | Purpose                                                               | Config                    |
| -------- | --------------------------------------------------------------------- | ------------------------- |
| semgrep  | static source rules (`.semgrep.yml`, fully vendored, `--metrics=off`) | `.semgrep.yml`            |
| trivy    | dependency/lockfile CVEs + misconfig + secrets in the filesystem      | `infra/deploy/trivy.yaml` |
| gitleaks | secret scanning, filesystem mode only (`dir`, never `detect`/`git`)   | `.gitleaks.toml`          |

All three run against the repository as a plain directory tree, never
against a git history - this repo has none (ADR 0003), and even if it did,
the scanners are invoked in filesystem mode by construction (see
`scripts/guards/security-scan-lib.ts`'s argv builders - a test asserts the
gitleaks argv always contains the literal `dir` subcommand and never a
standalone `git` token). Trivy and gitleaks bind-mount the target read-only
(`-v <repo>:/src:ro`). Semgrep does NOT: on this box, bind-mount I/O made a
full-tree scan take 1,228s wall clock, so its sources are instead packed
into a ustar archive and streamed on the container's stdin (`docker run -i
... sh -c 'tar -xf - -C /src && ...'`) - see
`docs/evidence/P29-security-scans.md`'s "Perf fix" section for the measured
before/after (1,228s -> ~5s).

## When the scanners run

- Every gate run (`pnpm run check:semgrep`, `check:trivy`, `check:secret-scan`
  - three CI steps in `scripts/ci-steps.ts`, right after `alert-rules`).
- Once a production image exists, the SAME pinned trivy image scans that
  image (`trivy image ...`) before every deploy - see the `image:` section
  at the bottom of `infra/deploy/trivy.yaml` for the exact command shape.

## Fail-safe scanning behaviour

A scanner that cannot run - Docker missing, the pinned image cannot be
pulled, or its vulnerability/rule database cannot be downloaded - FAILS the
build/deploy. It is never treated as an implicit pass. This mirrors the
product's own fail-safe invariant (an unclear state pauses, it never
proceeds blindly): `classifyScannerExit` in
`scripts/guards/security-scan-lib.ts` maps a missing tool to `tool-missing`
(exit 2, a `BLOCKED:`-prefixed message) and a database-download failure to
`db-download-failed` (exit 3) - neither can ever produce exit code 0.
