import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  bannedIdentifierPattern,
  findDrizzleSecondReserveSetBrace,
  FORBIDDEN_IDENTIFIER_MESSAGE,
  FORBIDDEN_MESSAGE,
  hasCounterColumnWrite,
  lineOfIndex,
  literalSpans,
  stripComments,
} from './guards/single-reserve-lib.js';
import type { SourceFile } from './guards/single-reserve-lib.js';

/**
 * check-single-reserve.ts (P13 Unit U3, step 5) - enforces that
 * `db/queries/reserve-pacing.sql` and `db/queries/release-pacing.sql` are
 * the ONLY statements in the system allowed to write
 * `pacing_ledger.consumed_count`, `sent_this_hour`, `new_conv_count` or
 * `group_sent_count` (see reserve-pacing.sql's own header comment, point 1
 * - core invariant 3, idempotency at the storage layer: a second
 * reserve-style UPDATE anywhere else would be a second, uncoordinated
 * authority over the same counters, exactly the dual-authority regression
 * `instance_pacing_state` carrying no counter columns already guards
 * against at the schema level). Modelled closely on
 * `check-single-claim.ts` - same three bypass shapes, same scanned globs,
 * same self-scan avoidance idiom.
 *
 * Scans every TS/TSX source file plus every raw `.sql` file across the five
 * ADR 0014 source trees (`app`, `admin`, `website`, `packages`, `db` -
 * including `db/tests/**` and `db/schema/**`, plus any raw `.sql` under
 * `app/`, `admin/`, `infra/`, `db/tests/`, `packages/`, `website/`) and
 * `scripts/` for THREE independent bypass shapes:
 *
 *   1. Literal-value UPDATE ... SET ... <column> = ... (any of the four
 *      tracked columns), ANY CASE, ANY WHITESPACE - see
 *      COLUMN_WRITE_PATTERN. The right-hand side is intentionally
 *      unconstrained (unlike check-single-claim.ts's single banned literal
 *      value 'processing', this guard bans writing these columns to ANY
 *      value), so ONE pattern already covers both the literal and the
 *      parameterized-bind shapes check-single-claim.ts needs two patterns
 *      for.
 *   2. The Drizzle ORM equivalent - a `pacingLedger` table's
 *      `update(...).set({...})` call with one of the four columns as a
 *      top-level key, no UPDATE/SET SQL text anywhere - see
 *      findDrizzleSecondReserveSetBrace.
 *   3. The banned identifier named by `single-reserve-lib.ts`'s
 *      `BANNED_IDENTIFIER_LABEL` (see below) anywhere in the tree.
 *
 * `db/queries/reserve-pacing.sql` and `db/queries/release-pacing.sql` are
 * the two sanctioned exemptions for bypass shapes 1 and 2 (release-pacing
 * legitimately DECREMENTS the same four columns as a post-commit refund -
 * see that file's own header). Bypass shape 3 (the banned identifier) has
 * no path-based exemption other than this guard's own source files
 * (`single-reserve-lib.ts` names the identifier via string concatenation,
 * never as a literal token, specifically so it never counts as a real
 * occurrence - see that file's own comment).
 *
 * BANNED IDENTIFIER, folded into this guard rather than a separate
 * `scripts/check-no-forbidden-mechanism.ts` (the phase file names that
 * file; it does not exist in this repo - the main session decided the ban
 * lives here instead, since this guard was already becoming a CI step and
 * a whole second guard file for one banned token would be needless
 * ceremony): the banned identifier (spelled out once, by concatenation, as
 * `single-reserve-lib.ts`'s `BANNED_IDENTIFIER_LABEL` - never written here
 * as a contiguous literal, so this file cannot trip its own scan) named a
 * worker-side pacing gap cache
 * (`app/backend/src/engine/queue/interim-gap.ts`) that re-created
 * Blastup's TOCTOU race - a worker holding a locally-cached minimum gap
 * instead of reading `instance_pacing_state`/`pacing_ledger` in-statement
 * on every reserve is exactly the "worker-side limits cache" reserve-
 * pacing.sql's header (point 2) forbids. U4 is deleting that file and its
 * test in parallel with this unit - the live repo scan may therefore still
 * report this identifier while both units are in flight; see this guard's
 * own CLI output / this unit's report for whether that is the case at the
 * time this guard was last run.
 */

/** The two files allowed to write the four tracked pacing_ledger counter columns. */
export const SINGLE_RESERVE_EXEMPT_PATHS = [
  'db/queries/reserve-pacing.sql',
  'db/queries/release-pacing.sql',
];

/** Same five ADR 0014 source trees (including db/tests, db/schema), every raw `.sql` file, plus `scripts/`. */
export const SINGLE_RESERVE_GLOBS = [
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

/**
 * Pure core - no filesystem access. `.sql` files are checked whole-content
 * (except paths in `exemptPaths`); every other file's column-write check is
 * per string/template-literal span, mirroring `scanSingleClaim`.
 */
export function scanSingleReserveColumns(
  files: SourceFile[],
  exemptPaths: readonly string[],
): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (file.path.endsWith('.sql')) {
      if (exemptPaths.includes(file.path)) continue;
      if (hasCounterColumnWrite(file.content)) {
        violations.push({
          file: file.path,
          message: FORBIDDEN_MESSAGE,
        });
      }
      continue;
    }

    for (const span of literalSpans(file.content)) {
      if (hasCounterColumnWrite(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: FORBIDDEN_MESSAGE,
        });
      }
    }

    const drizzleBraceIndex = findDrizzleSecondReserveSetBrace(stripComments(file.content));
    if (drizzleBraceIndex !== undefined) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, drizzleBraceIndex),
        message: FORBIDDEN_MESSAGE,
      });
    }
  }

  return violations;
}

/**
 * Banned-identifier scan: flags every occurrence of the identifier named by
 * `bannedIdentifierPattern()` (`single-reserve-lib.ts`'s
 * `BANNED_IDENTIFIER_LABEL`) outside this guard's own source files
 * (`single-reserve-lib.ts` and this file never contain the identifier as a
 * contiguous literal token - see single-reserve-lib.ts's
 * `BANNED_IDENTIFIER_LABEL` comment - so no path-based exemption is needed
 * for them; they simply never match).
 */
export function scanBannedIdentifier(files: SourceFile[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  for (const file of files) {
    const pattern = bannedIdentifierPattern();
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(file.content)) !== null) {
      violations.push({
        file: file.path,
        line: lineOfIndex(file.content, match.index),
        message: FORBIDDEN_IDENTIFIER_MESSAGE,
      });
    }
  }
  return violations;
}

export function scanSingleReserve(
  files: SourceFile[],
  exemptPaths: readonly string[],
): GuardViolation[] {
  return [...scanSingleReserveColumns(files, exemptPaths), ...scanBannedIdentifier(files)];
}

function readSourceFiles(): SourceFile[] {
  return resolveFiles(SINGLE_RESERVE_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckSingleReserve(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanSingleReserve(files, SINGLE_RESERVE_EXEMPT_PATHS),
    filesScanned: files.length,
  };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanSingleReserve(files, SINGLE_RESERVE_EXEMPT_PATHS);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `single-reserve: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `single-reserve: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`single-reserve: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
