import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';

/**
 * check-tree.ts (P00 step 6) - the top-level folder allow-list check.
 *
 * Mechanizes SESSION-PROTOCOL C4 ("no file outside the tree"): the ADR 0014
 * shipped tree is an exact allow-list, checked at two levels - the repo
 * root, and one level deeper under app/, admin/, db/ and infra/ (the only
 * top-level directories whose *contents* are themselves part of the ADR
 * 0014 shape; packages/*, website/, docs/, scripts/ are free-form inside
 * their own root). Active TODAY - unlike check-tenant-scope, there is
 * nothing to wait for; the tree exists now.
 */

export interface TreeViolation {
  path: string;
  message: string;
}

const ALLOWED_TOP_LEVEL_DIRS = new Set([
  'app',
  'admin',
  'website',
  'packages',
  'db',
  'infra',
  'scripts',
  'docs',
  // Pre-existing workspace docs/dirs (see CLAUDE.md) - not shipped product
  // code, but part of this workspace's allow-listed tree.
  'demo',
  'plan',
  'node_modules',
  '.claude',
  '.memory',
  // Dev-only key rings from `scripts/gen-key-ring.mjs` (P01 step 10) -
  // intended to be snapshot-excluded (see docs/CONVENTIONS.md), never
  // committed to a real deploy artifact, never overwritten once written.
  '.secrets',
  // Machine-local object-store data (P20 Unit U3, platform/storage's fs
  // driver default rootDir) - deliberately OUTSIDE every SCAN_GLOBS root so
  // uploaded tenant CSVs are never scanned by check-copy or any other guard.
  '.data',
]);

const ALLOWED_TOP_LEVEL_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  '.npmrc',
  '.gitignore',
  '.prettierignore',
  'tsconfig.json',
  'vitest.config.ts',
  '.dependency-cruiser.cjs',
  // P29a launch-hardening Unit U1 - pinned-Docker-image security scanner
  // configs (see scripts/guards/security-scan-lib.ts).
  '.semgrep.yml',
  '.gitleaks.toml',
  '.semgrepignore',
  // Production image (2026-09-14). Both MUST sit at the repo root: `docker
  // build` resolves `.dockerignore` only next to the build context root, and
  // the Dockerfile's build stage needs the whole workspace (app/backend,
  // admin/backend, packages, db, scripts) in one context to run `tsc -b`
  // across the project references. Moving either under infra/ would silently
  // disable the ignore file and break the build. The compose file that runs
  // this image lives under infra/compose/ with its dev sibling.
  'Dockerfile',
  '.dockerignore',
  'VERSION',
  'CHANGELOG.md',
  // Pre-existing workspace docs (see CLAUDE.md).
  'plan.html',
  'MASTER-PLAN.md',
  'CLAUDE.md',
  // Pre-existing founder note, allow-listed deliberately (see CLAUDE.md).
  'my-prompt.md',
]);

const ALLOWED_TOP_LEVEL = new Set([...ALLOWED_TOP_LEVEL_DIRS, ...ALLOWED_TOP_LEVEL_FILES]);

const ALLOWED_APP_ADMIN_SECOND_LEVEL = new Set(['frontend', 'backend']);

const ALLOWED_DB_SECOND_LEVEL = new Set([
  'schema',
  'migrations',
  'queries',
  'seeds',
  'src',
  // P02: db integration tests (real Postgres) + their vitest project config -
  // run via `pnpm -F @wp/db test` (root `test:int`), excluded from the unit
  // suite (design §6.5; P02 session).
  'tests',
  'vitest.config.ts',
  'package.json',
  'tsconfig.json',
  'README.md',
]);

const ALLOWED_INFRA_SECOND_LEVEL = new Set([
  'compose',
  'deploy',
  'nginx',
  'observability',
  'backup',
]);

/**
 * Build artifacts that may legally sit inside a checked directory even
 * though they are not part of the ADR 0014 tree - mirrors
 * `scripts/guards/registry.ts`'s `ARTIFACT_EXCLUSIONS`. Never a place to
 * hide a real tree violation: only exact artifact names/suffixes.
 */
function isArtifact(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === 'dist' ||
    name === 'coverage' ||
    name.endsWith('.tsbuildinfo')
  );
}

/**
 * Pure check: `entries` is a flat list of repo-relative, posix-separated
 * paths - top-level names (`"app"`, `"package.json"`) plus one level deeper
 * under app/admin/db/infra (`"app/backend"`, `"db/schema"`). Anything else
 * is out of scope for this checker (packages/*, website/, docs/, scripts/
 * are only checked for their own top-level presence, never recursed into).
 */
export function checkTree(entries: string[]): TreeViolation[] {
  const violations: TreeViolation[] = [];

  for (const entry of entries) {
    const parts = entry.split('/');

    if (parts.length === 1) {
      const name = parts[0];
      if (name === undefined) continue;
      if (isArtifact(name) || ALLOWED_TOP_LEVEL.has(name)) {
        continue;
      }
      violations.push({
        path: entry,
        message: `top-level entry "${entry}" is outside the ADR 0014 tree (see check-tree.ts's allow-list)`,
      });
      continue;
    }

    if (parts.length === 2) {
      const [top, child] = parts;
      if (top === undefined || child === undefined) continue;
      if (isArtifact(child)) {
        continue;
      }
      if (top === 'app' || top === 'admin') {
        if (!ALLOWED_APP_ADMIN_SECOND_LEVEL.has(child)) {
          violations.push({
            path: entry,
            message: `"${entry}" is not allowed under ${top}/ - only frontend/ and backend/ (ADR 0014)`,
          });
        }
      } else if (top === 'db') {
        if (!ALLOWED_DB_SECOND_LEVEL.has(child)) {
          violations.push({
            path: entry,
            message: `"${entry}" is not allowed under db/ (ADR 0014: schema|migrations|queries|seeds|src|tests + package/tsconfig/vitest.config/README)`,
          });
        }
      } else if (top === 'infra') {
        if (!ALLOWED_INFRA_SECOND_LEVEL.has(child)) {
          violations.push({
            path: entry,
            message: `"${entry}" is not allowed under infra/ (ADR 0014: compose|deploy|nginx|observability|backup)`,
          });
        }
      }
      continue;
    }
  }

  return violations;
}

/**
 * A checked-in `scripts/**\/*.js`, `*.d.ts`, or `*.map` file is (M6) an
 * accidental `tsc` emit: `scripts/tsconfig.json` has `noEmit: true`, so
 * nothing under `scripts/` is meant to ship a compiled sibling. A stray
 * `.js` next to its `.ts` source is a stale-guard hazard - a bare-specifier
 * import (`../check-tenant-scope.js`) resolves to whichever file is on disk,
 * and a stale compiled `.js` can silently shadow edits made only to the
 * `.ts`. `scripts/guards/__fixtures__/**` is excluded - those `.js` files are
 * real guard-test fixtures, never emitted artifacts - and `.mjs` files (e.g.
 * `gen-key-ring.mjs`) are a different, intentionally-run runtime, never
 * `tsc` output.
 */
const SCRIPTS_FIXTURES_PREFIX = 'scripts/guards/__fixtures__/';

function isEmittedArtifact(entry: string): boolean {
  return entry.endsWith('.js') || entry.endsWith('.d.ts') || entry.endsWith('.map');
}

/**
 * Pure check: `entries` are repo-relative, posix-separated paths already
 * known to live under `scripts/` (e.g. from `resolveFiles`). No filesystem
 * access here - mirrors `checkTree`'s pure-function shape.
 */
export function checkScriptsEmittedArtifacts(entries: string[]): TreeViolation[] {
  const violations: TreeViolation[] = [];

  for (const entry of entries) {
    if (entry.startsWith(SCRIPTS_FIXTURES_PREFIX)) continue;
    if (entry.endsWith('.mjs')) continue;
    if (!isEmittedArtifact(entry)) continue;
    violations.push({
      path: entry,
      message: `"${entry}" is a checked-in emitted build artifact (scripts/tsconfig.json has noEmit: true) - delete it; a stray .js/.d.ts can shadow its .ts source`,
    });
  }

  return violations;
}

/** Every file under `scripts/`, recursively, excluding build-artifact noise (node_modules/dist/etc). */
function buildScriptsEntries(): string[] {
  return resolveFiles(['scripts/**/*']);
}

/** Reads the real filesystem: top-level entries + one level under app/admin/db/infra. */
export function buildTreeEntries(repoRoot: string): string[] {
  const entries: string[] = [...readdirSync(repoRoot)];

  for (const top of ['app', 'admin', 'db', 'infra']) {
    const topPath = path.join(repoRoot, top);
    let children: string[];
    try {
      children = readdirSync(topPath);
    } catch {
      continue;
    }
    for (const child of children) {
      entries.push(`${top}/${child}`);
    }
  }

  return entries;
}

function allTreeViolations(): TreeViolation[] {
  return [
    ...checkTree(buildTreeEntries(REPO_ROOT)),
    ...checkScriptsEmittedArtifacts(buildScriptsEntries()),
  ];
}

export function runCheckTree(): GuardResult {
  const violations: GuardViolation[] = allTreeViolations().map((violation) => ({
    file: violation.path,
    message: violation.message,
  }));
  return { violations };
}

function main(): void {
  const topLevel = readdirSync(REPO_ROOT);
  const violations = allTreeViolations();

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`check-tree: ${violation.path} - ${violation.message}`);
    }
    process.exit(1);
  }

  console.log(`check-tree: OK (${topLevel.length} top-level entries)`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
