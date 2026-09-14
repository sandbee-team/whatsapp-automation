import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';

/**
 * Leaf module (P00 step 3 follow-up) - repo-root resolution, the shared
 * file-scan config, and the guard result types.
 *
 * This module MUST NOT import from `./registry.js`, `../check-tree.js`, or
 * `../check-tenant-scope.js` (or anything that transitively does). Those
 * three files all need `REPO_ROOT`/`resolveFiles`/the `Guard*` types, and
 * `registry.ts` also needs to import run functions and globs *from*
 * `check-tree.ts`/`check-tenant-scope.ts` - if the constants lived in
 * `registry.ts` itself, that made a real circular import (registry -> check-*
 * -> registry) whose evaluation order depends on which file is the CLI entry
 * module, and crashed with a TDZ `ReferenceError` when `check-tenant-scope.ts`
 * was invoked directly (see `.memory/lessons/`). Keeping this file a pure
 * leaf breaks the cycle structurally: `check-tree.ts` and
 * `check-tenant-scope.ts` depend only on this file, never on `registry.ts`.
 */

export interface GuardViolation {
  file: string;
  line?: number;
  message: string;
}

export interface GuardResult {
  violations: GuardViolation[];
  /**
   * Optional: how many files the guard actually read. Lets a test assert a
   * non-zero scanned count directly against the `run*` function's own
   * return value, instead of a guard silently passing because its glob
   * matched nothing (see `check-single-claim.ts`'s
   * `the_real_repo_tree_today_has_zero_violations_and_a_non_zero_scanned_count`).
   */
  filesScanned?: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repo root, resolved from this file's location (scripts/guards/). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Positive scan roots - the ADR 0014 shipped tree. */
export const SCAN_GLOBS = [
  'app/**',
  'admin/**',
  'website/**',
  'packages/**',
  'db/**',
  'infra/**',
  'scripts/**',
  'docs/**',
];

/**
 * Content the scan intentionally skips even though it lives under a scanned
 * root. Frozen to exactly these three entries so it can never be silently
 * widened to hide a violation - see
 * `guard_scan_exclusions_are_exactly_demo_memory_and_fixtures`.
 */
export const CONTENT_EXCLUSIONS = ['demo/**', '.memory/**', 'scripts/guards/__fixtures__/**'];

/** Build artifacts only - never a place to hide a real violation. */
export const ARTIFACT_EXCLUSIONS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.tsbuildinfo',
  // Next.js static-export output and build cache - build artefacts, never a
  // place to hide a violation (P29).
  'website/out/**',
  '**/.next/**',
];

/**
 * Resolve a guard's globs against the repo root, applying both exclusion
 * lists. Returns posix-relative paths.
 */
export function resolveFiles(globs: string[]): string[] {
  return fg.sync(globs, {
    cwd: REPO_ROOT,
    ignore: [...CONTENT_EXCLUSIONS, ...ARTIFACT_EXCLUSIONS],
    onlyFiles: true,
    dot: false,
  });
}

export type PhaseStatus = 'todo' | 'in-progress' | 'done';

/**
 * Parse `plan/README.md`'s phase status table. Rows look like:
 * `| P00 | \`workspace-guards-and-domain\` | todo | ... |`
 * The 3rd cell is the status.
 */
export function parsePhaseStatus(readmeText: string): Map<string, PhaseStatus> {
  const statuses = new Map<string, PhaseStatus>();
  const rowPattern = /^\|\s*(P\d{2}[a-z]?)\s*\|\s*`[^`]*`\s*\|\s*(todo|in-progress|done)\s*\|/gm;
  for (const match of readmeText.matchAll(rowPattern)) {
    const [, id, status] = match;
    if (id && status) {
      statuses.set(id, status as PhaseStatus);
    }
  }
  return statuses;
}
