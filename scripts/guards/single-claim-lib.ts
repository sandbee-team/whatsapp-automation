/**
 * single-claim-lib.ts - span-sanitizer + violation-pattern half of
 * check-single-claim.ts (P03 Unit B, step 5; hardened P03 close, finding 4),
 * split out at P03 close for the max-lines cap, mirroring how
 * `scan-config.ts` is shared. The CLI entry file (`../check-single-claim.ts`)
 * keeps resolve/scan/report; this module owns the regex patterns, the
 * sanitizer, the Drizzle brace-balanced scanner, and the small text-position
 * helpers those need. See that file's own header for the full three-bypass-
 * shape rationale this module implements.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export const FORBIDDEN_MESSAGE =
  "check-single-claim: only db/queries/claim-jobs.sql may set message_jobs.status = 'processing' - " +
  'claiming a job (queued -> processing) must happen through the single canonical claim statement, ' +
  'never a second UPDATE variant.';

/**
 * Table token this guard cares about - snake_case (raw SQL / `pg` calls) or
 * camelCase (the Drizzle `messageJobs` schema export). Patterns 1 and 2
 * below only count as a violation when this token also appears in the same
 * matched span - see `hasLiteralOrParamStatusWrite`. Without that guard,
 * making the keyword match case-insensitive (finding 4c) would risk
 * tripping on ordinary lowercase English prose ("we update the row, then
 * set status = 'processing' internally") in a comment; requiring the real
 * table name alongside the UPDATE/SET shape keeps that firmly out of reach
 * while still catching a real bypass on any other table+keyword casing.
 */
const MESSAGE_JOBS_TOKEN = /\bmessage_jobs\b|\bmessageJobs\b/;

/**
 * Whitespace/quote resilient, ANY CASE: matches `UPDATE ... SET ...`
 * followed later in the same string/template literal (or the same raw
 * `.sql` file) by `status = 'processing'` / `status="processing"`, any
 * amount of whitespace around `=`. Requiring `SET` between `UPDATE` and
 * `status=` also keeps this from tripping on an unrelated `WHERE status =
 * 'processing'` partial-index predicate (see `message_jobs_lease_expiry_idx`,
 * migration 0007) - that is a read-path filter, not a claim. Both gaps are
 * bounded to `[^;]*?` (never crosses a `;` statement terminator) rather than
 * `[\s\S]*?` (any char, unbounded): for whole-file `.sql` scanning (see
 * `scanSingleClaim`) an unbounded gap could bridge two entirely unrelated
 * statements or comments in the same migration file (e.g. an incidental
 * lowercase "update" in a comment, paired with an unrelated later `SET`/
 * `status='...'` elsewhere in the file) - confining the match to one
 * statement keeps it structurally honest. The quote character class below
 * is written as `\x27`/`\x22` rather than literal `'`/`"` on purpose: this
 * file is itself scanned by this guard's own TS/literal-span pass
 * (`scripts/**\/*.ts` is in `SINGLE_CLAIM_GLOBS`), and a raw `'`/`"` here
 * would feed `literalSpans`' naive (non-escape-aware) quote pairing and can
 * pair with an unrelated quote elsewhere in this file, manufacturing a
 * phantom multi-line "string" that happens to satisfy this very pattern -
 * `\x27`/`\x22` are functionally identical inside a character class without
 * that risk. Case sensitivity was dropped (finding 4c: a future lowercase
 * `update ... set ...` variant is just as real a bypass as the uppercase
 * convention this codebase otherwise follows) - see MESSAGE_JOBS_TOKEN above
 * for how the resulting prose-false-positive risk is contained. Only ever
 * tested via `hasLiteralOrParamStatusWrite`, never on its own.
 *
 * Clause-bounded (debugger finding, P09): the gap between `SET` and
 * `status\s*=\s*'processing'` is `(?:(?!\bWHERE\b)[^;])*?`, not the plain
 * `[^;]*?` this used to be - a plain `[^;]*?` gap has no idea where the SET
 * clause's own assignment list ends and the WHERE clause's predicates begin,
 * so it happily matches PAST a `WHERE` keyword into an unrelated `status =
 * 'processing'` predicate later in the SAME statement. That is exactly the
 * standard conditional-transition shape this repo's queue rules require
 * elsewhere (`SET status = <new>, ... WHERE ... AND status = 'processing'` -
 * see `markNeedsReconcile` in `app/backend/src/engine/fleet/drain.ts`): a
 * completely legitimate UPDATE that never once sets status to 'processing'
 * was being flagged only because it USES 'processing' as a WHERE guard. The
 * negative lookahead `(?!\bWHERE\b)` forbids the gap from crossing a `WHERE`
 * token at all, so the match can only ever land inside the SET clause's own
 * assignment list - multi-line SET lists, extra assignments before the
 * status key, and any whitespace/case/quote variation are still matched
 * exactly as before (see the sneaky-shape fixtures this pattern is tested
 * against); only a WHERE-clause predicate is now correctly excluded. This is
 * a pure over-matching fix: nothing that used to be a true positive (a real
 * `SET ... status = 'processing' ...`, since `WHERE` cannot appear before a
 * statement's own `SET` clause) can newly evade this pattern - see
 * `hasLiteralOrParamStatusWrite`'s doc comment for the explicit false-negative
 * analysis.
 *
 * Row-lock-clause excluded (debugger finding, P12, 2026-09-01): a bare
 * `\bUPDATE\b` also matches `UPDATE` inside `FOR UPDATE`/`FOR UPDATE OF
 * <alias>`/`FOR UPDATE NOWAIT`/`FOR UPDATE SKIP LOCKED`/`FOR NO KEY UPDATE` -
 * the row-lock clause on a claim/sweep query (`db/queries/claim-jobs.sql`).
 * Not an UPDATE statement, but once matched it seeds the gap and runs into
 * the NEXT real `UPDATE`, landing on an unrelated `status = 'processing'`
 * downstream - exactly how migration 0027's `FOR UPDATE OF j SKIP LOCKED`
 * CTE clause false-positived (see `SANITIZE_SPAN_PATTERN` for the other
 * half). The two lookbehinds reject `UPDATE` preceded by `FOR ` or `FOR NO
 * KEY ` - `OF`/`NOWAIT`/`SKIP LOCKED` are suffixes, not prefixes, so nothing
 * further is needed; a genuine `UPDATE <table>` is never preceded by `FOR `.
 */
export const LITERAL_STATUS_PATTERN =
  /(?<!\bFOR\s)(?<!\bFOR\s+NO\s+KEY\s)\bUPDATE\b[^;]*?\bSET\b(?:(?!\bWHERE\b)[^;])*?status\s*=\s*[\x27\x22]processing[\x27\x22]/i;

/**
 * Same claim shape as LITERAL_STATUS_PATTERN, but for a parameterized bind
 * instead of a literal (finding 4b): `SET status = $1`, with the literal
 * `'processing'` value bound separately in TS (e.g. `pool.query('UPDATE
 * message_jobs SET status = $1 ...', ['processing'])`) - the SQL text alone
 * never contains the word "processing", so LITERAL_STATUS_PATTERN cannot see
 * it. Also only ever tested via `hasLiteralOrParamStatusWrite` (the
 * MESSAGE_JOBS_TOKEN co-occurrence requirement is what keeps a generic `SET
 * foo = $1` on an unrelated table from false-positiving here). Same `[^;]*?`
 * statement-bounded gaps as LITERAL_STATUS_PATTERN, same reasoning.
 *
 * P03 close (re-review round, item 4): the numeric-only `\$\d+` shape missed
 * NAMED parameter binds (`status = $status`, `status = $newStatus`) - a
 * second, equally real way to bypass LITERAL_STATUS_PATTERN's literal-text
 * requirement without going through positional placeholders at all. The
 * alternation below accepts `$<digits>` (positional) or `$<identifier>`
 * (named), case-insensitive, same as the rest of this file.
 *
 * Clause-bounded the same way as LITERAL_STATUS_PATTERN above (debugger
 * finding, P09) - same `(?:(?!\bWHERE\b)[^;])*?` gap instead of a plain
 * `[^;]*?`, for the identical reason: an UPDATE with an unrelated SET clause
 * and a WHERE predicate that happens to compare `status` to a parameter
 * (e.g. `... WHERE id = $1 AND status = $status`) is a normal conditional
 * transition guard, not a second claim path, and must not be confused with
 * one just because both keywords appear somewhere after SET in the same
 * statement.
 *
 * Row-lock-clause excluded (P12, 2026-09-01) - same two-lookbehind fix as
 * LITERAL_STATUS_PATTERN above.
 */
export const PARAMETERIZED_STATUS_PATTERN =
  /(?<!\bFOR\s)(?<!\bFOR\s+NO\s+KEY\s)\bUPDATE\b[^;]*?\bSET\b(?:(?!\bWHERE\b)[^;])*?\bstatus\s*=\s*\$(?:\d+|[A-Za-z_][A-Za-z0-9_]*)/i;

/**
 * P03 close, finding 2: neutralizes `;` characters that live inside a SQL
 * single-quoted string literal (`'(?:[^']|'')*'`, doubled-quote escaped) or
 * a `--` line comment, before LITERAL_STATUS_PATTERN/PARAMETERIZED_STATUS_PATTERN's
 * `[^;]*?`-bounded gaps run over `text`. Neither shape is a real statement
 * terminator - `lease_owner = 'a;b'` between `SET` and `status='processing'`,
 * or a `-- note; here` comment between `UPDATE` and `SET`, would otherwise
 * truncate the bounded gap and let the second-claim UPDATE slip past
 * undetected.
 *
 * P12 (2026-09-01) widened this from "blank only the `;` byte" to "blank the
 * WHOLE `--` comment body" (string literals still only get their `;` bytes
 * blanked - a string is real data, never prose). Migration 0027's reaper
 * UPDATE has a `--` comment between `SET` and `WHERE` containing the text
 * `j.status = 'processing'` (documenting that WHERE guard) - blanking only
 * `;` left it scannable, so the gap landed on the comment. A `--` comment
 * can never contain executable SQL, so blanking it only removes false
 * positives - see `bad-claim-comment-noise.sql` (tokens outside comment
 * spans stay untouched, so a comment cannot hide a real claim either). Both
 * replacements preserve length so `lineOfIndex` stays accurate.
 */
const SANITIZE_SPAN_PATTERN = /--[^\n]*|'(?:[^']|'')*'/g;

export function sanitizeForBoundedScan(text: string): string {
  return text.replace(SANITIZE_SPAN_PATTERN, (span) =>
    span.startsWith('--') ? ' '.repeat(span.length) : span.replace(/;/g, ' '),
  );
}

/**
 * True when `text` contains either bypass shape AND names
 * message_jobs/messageJobs.
 *
 * False-negative analysis (debugger, P09, in response to the WHERE-clause
 * false positive fixed on both patterns above): could the `(?:(?!\bWHERE\b)
 * [^;])*?` clause bound ever let a REAL `SET status = 'processing'` hide? No.
 * `WHERE` can only appear in a statement AFTER its own `SET` clause (SQL
 * grammar), so a genuine assignment is always found strictly before the
 * first `WHERE` the lookahead forbids crossing. The bound only ever removes
 * matches AFTER a `WHERE` keyword, i.e. inside the predicate list, never a
 * true positive for this guard (it governs status WRITES, not READS). Both
 * patterns keep full detection strength - see the sneaky-shape fixtures
 * (`bad-claim.sql` multi-line SET list, `bad-lowercase-claim.sql`,
 * `bad-named-param-claim.sql`) - while no longer flagging a WHERE-clause
 * predicate that merely mentions `status = 'processing'`.
 */
export function hasLiteralOrParamStatusWrite(text: string): boolean {
  if (!MESSAGE_JOBS_TOKEN.test(text)) return false;
  const sanitized = sanitizeForBoundedScan(text);
  return LITERAL_STATUS_PATTERN.test(sanitized) || PARAMETERIZED_STATUS_PATTERN.test(sanitized);
}

/**
 * Drizzle ORM equivalent of the banned claim UPDATE (finding 4a): no
 * UPDATE/SET SQL string literal anywhere, so neither pattern above (which
 * only scan string/template-literal spans, see `scanSingleClaim`) can see
 * it. Matches the `messageJobs` table's `update(...)` call - any internal
 * whitespace between the parens and the table name - chained to a
 * `.set({ ... })` call whose object literal contains a `status:` key, set to
 * ANY value: a literal `'processing'` string OR a variable/expression.
 * Intentionally broader than "only the literal 'processing' value": claiming
 * (queued -> processing) is the only legitimate status write this guard
 * governs, so any status key written through the `messageJobs` table's
 * `update(...).set(...)` gets flagged, literal or not. If this ever
 * over-flags a legitimate future transition writer (e.g. a terminal-state
 * writer that also happens to go through this same `update(...).set({status:
 * ...})` shape), the fix is naming that file in the guard's exemption
 * mechanism (today `SINGLE_CLAIM_EXEMPT_PATH`, widen to an array if a second
 * legitimate path is ever needed) - never loosening this pattern. The whole
 * point is that every status write to this table gets a human decision, not
 * a silent pass. (Comments here deliberately never spell out the literal
 * `update(messageJobs)` shape contiguously - see the module doc's parenthetical
 * for why: this file is itself scanned by this same guard.)
 *
 * P03 close, finding 3: a single-level `[^}]*` object-body scan cannot cross
 * a NESTED object literal (`{ payload: { a: 1 }, status: 'processing' }` -
 * the inner `}` ends the `[^}]*` match before the real `status` key is ever
 * reached), and a bare same-expression chain cannot see a claim `.set(...)`
 * called on a variable the `update(messageJobs)` result was assigned to in
 * an earlier statement (`const b = db.update(messageJobs); b.set({ status:
 * ... })`). `findDrizzleSecondClaimSetBrace` below replaces this regex with
 * brace-balanced object scanning (`objectLiteralHasTopLevelStatusKey`) across
 * both the same-expression chain AND the variable-binding shape.
 */
const DRIZZLE_CHAIN_SET_OBJECT_PATTERN = /\bupdate\s*\(\s*messageJobs\s*\)[^;]*?\.set\s*\(\s*\{/gi;

/** `const`/`let`/`var`/bare assignment of an `update(messageJobs)` result to a binding name, same statement only. */
const DRIZZLE_BINDING_PATTERN =
  /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=[^;]*?\bupdate\s*\(\s*messageJobs\s*\)/gi;

/**
 * Brace-balanced scan of the object literal starting at `text[openBraceIndex]`
 * (which must be `{`) - returns whether it contains a `status` key at the
 * object's OWN top level, never inside a nested object/array value one level
 * deeper (the `[^}]*` hole this replaces, finding 3a).
 */
function objectLiteralHasTopLevelStatusKey(text: string, openBraceIndex: number): boolean {
  let depth = 0;
  let topLevelText = '';
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1) topLevelText += ch;
  }
  return /\bstatus\s*:/.test(topLevelText);
}

/**
 * Finds a `.set({ ... status: ... })` object literal reachable from an
 * `update(messageJobs)` call, either (a) chained directly in the same
 * statement (`DRIZZLE_CHAIN_SET_OBJECT_PATTERN`), or (b) via a variable the
 * `update(messageJobs)` result was assigned to, with `.set(` called on that
 * same binding in ANY later statement (`DRIZZLE_BINDING_PATTERN` + a
 * `<name>.set({` search) - finding 3b, the split-builder bypass. Returns the
 * matched object literal's opening `{` index, or undefined when clean.
 * Intentionally NOT "any `.set(...)` with a status key anywhere in the
 * file": `scripts/guards/__fixtures__/single-claim/clean-drizzle.ts` pairs a
 * clean `update(messageJobs).set({ leaseOwner: ... })` with an UNRELATED
 * `update(someOtherTable).set({ status: ... })` in the same file - only a
 * `.set(` actually reachable from a `messageJobs` update (same expression or
 * the same binding) may ever be flagged.
 */
export function findDrizzleSecondClaimSetBrace(content: string): number | undefined {
  const chainPattern = new RegExp(
    DRIZZLE_CHAIN_SET_OBJECT_PATTERN.source,
    DRIZZLE_CHAIN_SET_OBJECT_PATTERN.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = chainPattern.exec(content)) !== null) {
    const braceIndex = match.index + match[0].length - 1;
    if (objectLiteralHasTopLevelStatusKey(content, braceIndex)) return braceIndex;
  }

  const bindingPattern = new RegExp(DRIZZLE_BINDING_PATTERN.source, DRIZZLE_BINDING_PATTERN.flags);
  while ((match = bindingPattern.exec(content)) !== null) {
    const name = match[1];
    if (!name) continue;
    const setPattern = new RegExp(`\\b${name}\\s*\\.set\\s*\\(\\s*\\{`, 'gi');
    setPattern.lastIndex = match.index + match[0].length;
    let setMatch: RegExpExecArray | null;
    while ((setMatch = setPattern.exec(content)) !== null) {
      const braceIndex = setMatch.index + setMatch[0].length - 1;
      if (objectLiteralHasTopLevelStatusKey(content, braceIndex)) return braceIndex;
    }
  }

  return undefined;
}

export function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// Comment-stripping + literal-span helpers live in single-claim-spans.ts
// (split out at FIX-P09-B for the max-lines cap) - re-exported here so every
// existing `from './guards/single-claim-lib.js'` import keeps working.
export { stripComments, literalSpans } from './single-claim-spans.js';
