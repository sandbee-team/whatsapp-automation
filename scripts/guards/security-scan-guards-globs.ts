/**
 * security-scan-guards-globs.ts (P29a semgrep-streaming perf fix) - the
 * guard glob constants, split into their own leaf module so both
 * `security-scan-tar.ts` (needs `SEMGREP_GUARD_GLOBS` to build the streamed
 * archive) and `security-scan-runner.ts` (needs it for the guard's
 * `resolveFiles` proof-of-match) can import it without a cycle
 * (`security-scan-lib.ts` -> `security-scan-tar.ts` -> here, never back
 * through `security-scan-runner.ts`).
 */

/**
 * Guard globs - what semgrep scans. ONE whole-tree source glob, on purpose
 * (P29a C1 re-review, 2026-09-09): the tar stream ships exactly what these
 * globs resolve to, and every hand-listed tree we tried missed something
 * real (`infra/`, `docs/__tests__`, then the .tsx files under `packages/<pkg>/src` - the whole
 * `@wp/ui` library - and `db/schema/`). A whole-tree glob mirrors what the
 * original bind-mount scan of `/src` covered; `resolveFiles` applies the same
 * artefact/content exclusions every guard uses (node_modules, dist, coverage,
 * website/out, .next, demo, .memory, guard fixtures) and, with `dot: false`,
 * never descends into dot-directories (.claude, .secrets, .data, .turbo).
 * Test-file and fixture exclusion for the RULES stays in the CLI `--exclude`
 * flags (`security-scan-lib.ts`), not here.
 */
export const SEMGREP_GUARD_GLOBS = ['**/*.{ts,tsx,js,mjs,cjs}'];

/** Guard globs - trivy scans the lockfile + its own config + Dockerfiles. */
export const TRIVY_GUARD_GLOBS = ['pnpm-lock.yaml', 'infra/deploy/trivy.yaml', '**/Dockerfile*'];

/** Guard globs - secret scan covers source plus docs/infra text surfaces. */
export const SECRET_SCAN_GUARD_GLOBS = [
  ...SEMGREP_GUARD_GLOBS,
  'infra/**/*.{yml,yaml,md,conf,example}',
  'docs/**/*.md',
];
