/**
 * no-auto-requeue-lib.ts (P12 Unit U5, step 8) - pattern/heuristic half of
 * `check-no-auto-requeue.ts`, split out for max-lines discipline (the
 * `single-claim-lib.ts` idiom). Mirrors that guard's own bounded-scan
 * structure closely - see `check-single-claim.ts`'s doc comment for the
 * shared design: `.sql` files scanned whole-content, `.ts`/`.tsx` scanned
 * per string/template-literal span (`literalSpans`), comments stripped
 * before the Drizzle-style / structural checks, `--`/`;`-inside-string
 * neutralised before the bounded gaps run.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export const FORBIDDEN_MESSAGE =
  'check-no-auto-requeue: only unresolved.service.ts may contain an UPDATE that moves a job OUT of ' +
  'blocked_needs_review, and it must be inside a function that takes an actor - core invariant 2 ' +
  '(fail-safe: no automatic requeue, ever).';

/**
 * The SQL string "blocked_needs_review" - built by concatenation in one
 * place (`BLOCKED_LABEL`) and reused everywhere below, so this guard's OWN
 * source never spells the full banned-transition shape as one contiguous
 * literal (same self-referential-trap avoidance `single-claim-lib.ts`'s doc
 * comment explains for its own patterns - this file is itself scanned by
 * `NO_AUTO_REQUEUE_GLOBS`, which includes `scripts/**\/*.ts`).
 */
const BLOCKED_LABEL = ['blocked', 'needs', 'review'].join('_');

/**
 * A SET clause that writes `status` to any value OTHER than
 * `'blocked_needs_review'` itself (a write INTO the state is not this
 * guard's concern - only a write OUT of it is), followed later in the SAME
 * statement by a WHERE-clause predicate `status = 'blocked_needs_review'`.
 * Both gaps are `[^;]*?`-bounded (never cross a `;` statement terminator),
 * matching `single-claim-lib.ts`'s own bounded-scan discipline for the
 * identical false-positive-avoidance reason. The `(?!'blocked_needs_
 * review')` negative lookahead on the SET value excludes the (currently
 * nonexistent, but harmless-if-ever-written) no-op
 * `SET status = 'blocked_needs_review' ... WHERE status = 'blocked_needs_
 * review'` shape - a write that doesn't change the value is not a
 * transition out of it.
 */
function buildTransitionPattern(): RegExp {
  return new RegExp(
    `\\bUPDATE\\b[^;]*?\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\bstatus\\s*=\\s*['"](?!${BLOCKED_LABEL}['"])[^'"]+['"]` +
      `(?:(?!;)[\\s\\S])*?\\bWHERE\\b(?:(?!;)[^;])*?\\bstatus\\s*=\\s*['"]${BLOCKED_LABEL}['"]`,
    'i',
  );
}

export const TRANSITION_OUT_OF_BLOCKED_PATTERN = buildTransitionPattern();

/**
 * Blanks `--` line-comment bodies and neutralises `;` inside single-quoted
 * SQL string literals, length-preserving (same technique as
 * `single-claim-lib.ts#sanitizeForBoundedScan`, same reasons: a `--`
 * comment can never contain executable SQL, and a `;` inside a string
 * literal is not a real statement terminator).
 */
const SANITIZE_SPAN_PATTERN = /--[^\n]*|'(?:[^']|'')*'/g;

export function sanitizeForBoundedScan(text: string): string {
  return text.replace(SANITIZE_SPAN_PATTERN, (span) =>
    span.startsWith('--') ? ' '.repeat(span.length) : span.replace(/;/g, ' '),
  );
}

/**
 * Excludes a `FOR UPDATE` / `FOR UPDATE OF <alias>` / `FOR UPDATE NOWAIT` /
 * `FOR UPDATE SKIP LOCKED` / `FOR NO KEY UPDATE` row-lock clause from ever
 * seeding this pattern's `\bUPDATE\b` anchor - the identical trap
 * `single-claim-lib.ts`'s `LITERAL_STATUS_PATTERN` was fixed for earlier
 * this session (see `.memory/lessons/2026-09-01-for-update-skip-locked-
 * false-positives-the-claim-guard.md`). Applied by stripping the row-lock
 * clause's `UPDATE` token before the transition pattern ever runs, rather
 * than a lookbehind on the pattern itself - simpler here because this
 * guard's `UPDATE` anchor is reused inside one longer alternation-free
 * pattern rather than two near-duplicate ones.
 */
const FOR_UPDATE_CLAUSE_PATTERN =
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b(?:\s+OF\s+\w+)?(?:\s+NOWAIT)?(?:\s+SKIP\s+LOCKED)?/gi;

function stripRowLockClauses(text: string): string {
  return text.replace(FOR_UPDATE_CLAUSE_PATTERN, (match) => ' '.repeat(match.length));
}

/** True when `text` contains a real transition OUT of `blocked_needs_review` (row-lock clauses and comments excluded first). */
export function hasTransitionOutOfBlocked(text: string): boolean {
  const withoutRowLocks = stripRowLockClauses(text);
  const sanitized = sanitizeForBoundedScan(withoutRowLocks);
  return TRANSITION_OUT_OF_BLOCKED_PATTERN.test(sanitized);
}

export function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}
