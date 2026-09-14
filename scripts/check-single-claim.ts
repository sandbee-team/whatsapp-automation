import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, resolveFiles } from './guards/scan-config.js';
import type { GuardResult, GuardViolation } from './guards/scan-config.js';
import {
  FORBIDDEN_MESSAGE,
  findDrizzleSecondClaimSetBrace,
  hasLiteralOrParamStatusWrite,
  lineOfIndex,
  LITERAL_STATUS_PATTERN,
  literalSpans,
  PARAMETERIZED_STATUS_PATTERN,
  sanitizeForBoundedScan,
  stripComments,
} from './guards/single-claim-lib.js';
import type { SourceFile } from './guards/single-claim-lib.js';

/**
 * check-single-claim.ts (P03 Unit B, step 5; hardened P03 close, finding 4) -
 * enforces that `db/queries/claim-jobs.sql` is the ONLY statement in the
 * system allowed to set `message_jobs.status = 'processing'` (see that
 * file's own header comment, point 1 - core invariant 3, idempotency at the
 * storage layer: a second claim-style UPDATE anywhere else would be a
 * second, uncoordinated path to the same state transition). Scans every
 * TS/TSX source file plus every raw `.sql` file across the five ADR 0014
 * source trees (`app`, `admin`, `website`, `packages`, `db` - including
 * `db/tests/**` and `db/schema/**`, plus any raw `.sql` under `app/`,
 * `admin/`, `infra/`, `db/tests/`, `packages/`, `website/`) and `scripts/`
 * for THREE independent bypass shapes, erring on the side of matching
 * rather than under-matching:
 *
 *   1. Literal-status UPDATE ... SET ... status = 'processing' (or
 *      ="processing"), ANY CASE, ANY WHITESPACE - see LITERAL_STATUS_PATTERN.
 *   2. The same shape with the literal value bound as a query parameter
 *      instead of embedded in the SQL text (`SET status = $1`, the literal
 *      'processing' bound separately in TS) - see
 *      PARAMETERIZED_STATUS_PATTERN.
 *   3. The Drizzle ORM equivalent - the `messageJobs` table's
 *      `update(...).set({ ... status: ... })` call, no UPDATE/SET SQL text
 *      anywhere - see DRIZZLE_UPDATE_SET_STATUS_PATTERN. (Written here as
 *      `update(...)` rather than `update(messageJobs)` on purpose - a
 *      contiguous literal match of the guard's own target shape would trip
 *      this guard's whole-file self-scan, the same self-referential trap
 *      `check-copy.ts`'s `OFFSET_WORD` avoids for its own pattern.)
 *
 * `db/queries/claim-jobs.sql` itself is the one sanctioned exemption.
 */

/** The one file allowed to contain the claim UPDATE. */
export const SINGLE_CLAIM_EXEMPT_PATH = 'db/queries/claim-jobs.sql';

/** The five ADR 0014 source trees' TS/TSX (including db/tests, db/schema), every raw `.sql` file, plus `scripts/`. */
export const SINGLE_CLAIM_GLOBS = [
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
 * (except `exemptPath`, the one legitimate claim statement); every other
 * file's LITERAL_STATUS_PATTERN/PARAMETERIZED_STATUS_PATTERN check is
 * per string/template-literal span, so an unrelated `UPDATE ...` far away in
 * the same file from an unrelated `status === 'processing'` comparison does
 * not false-positive. `findDrizzleSecondClaimSetBrace` is different by
 * necessity: a Drizzle `update(...).set({...})` call is real TS/TSX source
 * code, not a string/template literal, so it is matched against the WHOLE
 * file content instead (never applies to `.sql` files, which cannot contain
 * it).
 */
export function scanSingleClaim(files: SourceFile[], exemptPath: string): GuardViolation[] {
  const violations: GuardViolation[] = [];

  for (const file of files) {
    if (file.path.endsWith('.sql')) {
      if (file.path === exemptPath) continue;
      if (hasLiteralOrParamStatusWrite(file.content)) {
        const sanitized = sanitizeForBoundedScan(file.content);
        const match =
          LITERAL_STATUS_PATTERN.exec(sanitized) ?? PARAMETERIZED_STATUS_PATTERN.exec(sanitized);
        violations.push({
          file: file.path,
          line: match ? lineOfIndex(file.content, match.index) : undefined,
          message: FORBIDDEN_MESSAGE,
        });
      }
      continue;
    }

    for (const span of literalSpans(file.content)) {
      if (hasLiteralOrParamStatusWrite(span.text)) {
        violations.push({
          file: file.path,
          line: lineOfIndex(file.content, span.index),
          message: FORBIDDEN_MESSAGE,
        });
      }
    }

    // Comments stripped for the same reason as literalSpans above - real
    // executable code only, never documentation prose describing this shape.
    const drizzleBraceIndex = findDrizzleSecondClaimSetBrace(stripComments(file.content));
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

function readSourceFiles(): SourceFile[] {
  return resolveFiles(SINGLE_CLAIM_GLOBS).map((relativePath) => ({
    path: relativePath,
    content: readFileSync(path.join(REPO_ROOT, relativePath), 'utf8'),
  }));
}

export function runCheckSingleClaim(): GuardResult {
  const files = readSourceFiles();
  return {
    violations: scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH),
    filesScanned: files.length,
  };
}

function main(): void {
  const files = readSourceFiles();
  const violations = scanSingleClaim(files, SINGLE_CLAIM_EXEMPT_PATH);

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `single-claim: ${violation.file}:${String(violation.line ?? '?')} - ${violation.message}`,
      );
    }
    console.log(
      `single-claim: ${String(files.length)} files scanned, ${String(violations.length)} violation(s)`,
    );
    process.exit(1);
  }

  console.log(`single-claim: ${String(files.length)} files scanned, 0 violations`);
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
