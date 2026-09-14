import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  FORBIDDEN_MESSAGE,
  hasTransitionOutOfBlocked,
  lineOfIndex,
  sanitizeForBoundedScan,
  TRANSITION_OUT_OF_BLOCKED_PATTERN,
} from './guards/no-auto-requeue-lib.js';
import { nearestEnclosingFunctionTakesActor } from './guards/no-auto-requeue-actor.js';
import { literalSpans, stripComments } from './guards/single-claim-spans.js';
import type { SourceFile } from './guards/no-auto-requeue-lib.js';

/**
 * check-no-auto-requeue.ts (P12 Unit U5, step 8; P23 Unit U6 adds a second
 * exempt path; core invariant 2) - the ONLY files allowed to contain an
 * UPDATE moving a job OUT of `blocked_needs_review` are
 * `app/backend/src/modules/queue/unresolved.service.ts` and
 * `app/backend/src/modules/broadcasts/restamp.service.ts`
 * (`NO_AUTO_REQUEUE_EXEMPT_PATHS`), and that UPDATE must live inside a
 * function taking an `actor` parameter (see `no-auto-requeue-actor.ts`'s doc
 * comment for that heuristic's honest limits). Mirrors
 * `check-single-claim.ts`'s structure closely: `.sql` files scanned
 * whole-content, `.ts`/`.tsx` scanned per string/template-literal span so an
 * unrelated UPDATE far away in the same file from an unrelated status
 * comparison does not false-positive.
 */

/**
 * Both are human-gated exits out of `blocked_needs_review`, each behind its
 * own `assertUserActor`-style actor gate (P23 Unit U6 addition,
 * `restamp.service.ts` - the epoch-stranding sweep's re-stamp confirmation,
 * same actor-parameter discipline `unresolved.service.ts` established).
 */
export const NO_AUTO_REQUEUE_EXEMPT_PATHS: readonly [string, string] = [
  'app/backend/src/modules/queue/unresolved.service.ts',
  'app/backend/src/modules/broadcasts/restamp.service.ts',
];

/** Same five ADR 0014 source trees + `scripts/` as `check-single-claim.ts` - this guard governs the identical bypass surface (an UPDATE anywhere in the shipped tree), just for a different transition. */
export const NO_AUTO_REQUEUE_GLOBS = [
  'app/**/src/**/*.{ts,tsx}',
  'admin/**/src/**/*.{ts,tsx}',
  'website/src/**/*.{ts,tsx}',
  'packages/*/src/**/*.{ts,tsx}',
  'db/src/**/*.{ts,tsx}',
  'db/tests/**/*.{ts,tsx}',
  'db/schema/**/*.{ts,tsx}',
  'db/queries/**/*.sql',
  'db/migrations/**/*.sql',
  'db/seeds/**/*.sql',
  'db/tests/**/*.sql',
  'app/**/*.sql',
  'admin/**/*.sql',
  'infra/**/*.sql',
  'packages/**/*.sql',
  'website/**/*.sql',
  'scripts/**/*.ts',
];

function violationsForSqlText(filePath: string, content: string): GuardViolation[] {
  if (!hasTransitionOutOfBlocked(content)) return [];
  const sanitized = sanitizeForBoundedScan(content);
  const match = TRANSITION_OUT_OF_BLOCKED_PATTERN.exec(sanitized);
  return [
    {
      file: filePath,
      line: match ? lineOfIndex(content, match.index) : undefined,
      message: FORBIDDEN_MESSAGE,
    },
  ];
}

/**
 * Pure core - no filesystem access. `.sql` files are checked whole-content
 * except `exemptPath`; every other file's transition check runs per
 * string/template-literal span (never the whole file at once, same
 * `literalSpans` idiom `check-single-claim.ts` uses) - a match inside the
 * exempt path additionally requires `nearestEnclosingFunctionTakesActor` to
 * be true, otherwise it is STILL flagged (the exemption covers "this file
 * may contain the transition", not "this file may contain it anywhere").
 */
export function scanNoAutoRequeue(
  files: SourceFile[],
  exemptPaths: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    const isExempt = exemptPaths.includes(file.path);

    if (file.path.endsWith('.sql')) {
      if (isExempt) continue; // no .sql file is ever the exempt path in practice, kept for symmetry.
      violations.push(...violationsForSqlText(file.path, file.content));
      continue;
    }

    for (const span of literalSpans(file.content)) {
      if (!hasTransitionOutOfBlocked(span.text)) continue;

      if (isExempt) {
        // The span index is relative to the WHOLE file (literalSpans yields
        // indices into `file.content`, see single-claim-spans.ts), so the
        // actor-enclosure check runs against the whole file too - the
        // transition's line is what matters, not the literal span alone.
        const withoutRowLocks = sanitizeForBoundedScan(file.content);
        const match = TRANSITION_OUT_OF_BLOCKED_PATTERN.exec(withoutRowLocks);
        const matchIndex = match ? match.index : span.index;
        if (nearestEnclosingFunctionTakesActor(stripComments(file.content), matchIndex)) {
          continue;
        }
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, matchIndex),
          message: `${FORBIDDEN_MESSAGE} (found inside the exempt file, but not inside a function taking an actor)`,
        });
        continue;
      }

      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, span.index),
        message: FORBIDDEN_MESSAGE,
      });
    }
  }

  return violations;
}

/**
 * Test files are exempt, using the SAME pattern and the same reasoning as
 * `check-tenant-scope.ts:223`'s `TEST_FILE_PATTERN` (that guard filters its
 * own file list identically). A test legitimately performs the very
 * transition this guard polices, in order to PROVE it works: `db/tests/
 * unresolved-grants.test.ts` runs the retry/discard UPDATEs as `wp_app` to
 * prove migration 0028's grants are sufficient, and the unresolved API
 * integration tests assert the transition's outcome. Flagging those is a
 * false positive - the invariant this guard exists for is about PRODUCTION
 * code paths ("no automatic requeue, ever"), and a test asserting the
 * human-actioned transition is evidence FOR the invariant, not a second
 * path around it.
 *
 * This does NOT weaken the guard: the exemption is by path shape only, and
 * `scripts/__tests__/check-no-auto-requeue.test.ts` still drives planted
 * violations through `scanNoAutoRequeue` directly (fixtures under
 * `scripts/guards/__fixtures__/`), so a real second production path is
 * still caught with a non-zero matched-file count.
 */
const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.tsx?$/;

function readSourceFiles(): SourceFile[] {
  return resolveFiles(NO_AUTO_REQUEUE_GLOBS)
    .filter((relativePath) => !TEST_FILE_PATTERN.test(relativePath))
    .map((relativePath) => ({
      path: relativePath,
      content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
    }));
}

export function runCheckNoAutoRequeue(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS),
    filesScanned: files.length,
  };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanNoAutoRequeue(files, NO_AUTO_REQUEUE_EXEMPT_PATHS);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `check-no-auto-requeue: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `check-no-auto-requeue: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`check-no-auto-requeue: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
