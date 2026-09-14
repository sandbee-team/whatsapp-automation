/**
 * single-reserve-lib.ts - span-sanitizer + violation-pattern half of
 * check-single-reserve.ts (P13 Unit U3, step 5), split out at creation time
 * for the max-lines cap, mirroring how single-claim-lib.ts is split from
 * check-single-claim.ts. The CLI entry file (`../check-single-reserve.ts`)
 * keeps resolve/scan/report; this module owns the regex patterns, the
 * sanitizer, the Drizzle brace-balanced scanner, and the banned-identifier
 * scan those need. See that file's own header for the full bypass-shape and
 * banned-identifier rationale.
 */

export interface SourceFile {
  path: string;
  content: string;
}

/** The four columns only db/queries/reserve-pacing.sql and db/queries/release-pacing.sql may write. */
export const RESERVE_COUNTER_COLUMNS = [
  'consumed_count',
  'sent_this_hour',
  'new_conv_count',
  'group_sent_count',
] as const;

export type ReserveCounterColumn = (typeof RESERVE_COUNTER_COLUMNS)[number];

export const FORBIDDEN_MESSAGE =
  'check-single-reserve: only db/queries/reserve-pacing.sql and db/queries/release-pacing.sql may ' +
  'write pacing_ledger.consumed_count, sent_this_hour, new_conv_count or group_sent_count - ' +
  'consuming or refunding a pacing unit must happen through those two canonical statements, ' +
  'never a second UPDATE variant.';

// Built by concatenation, never as one contiguous literal, so this message
// constant does not itself trip bannedIdentifierPattern()'s own scan - the
// same self-referential trap check-copy.ts's OFFSET_WORD idiom avoids.
const BANNED_IDENTIFIER_LABEL = ['INTERIM', 'MIN', 'GAP', 'MS'].join('_');

export const FORBIDDEN_IDENTIFIER_MESSAGE =
  `check-single-reserve: the identifier ${BANNED_IDENTIFIER_LABEL} is banned anywhere in the tree ` +
  "except this guard's own banned-identifier list - it named a worker-side pacing gap cache that " +
  "re-created Blastup's TOCTOU race (see reserve-pacing.sql header, point 2: limits are read " +
  'IN-STATEMENT, never from a worker cache).';

/**
 * Table token this guard cares about - snake_case (raw SQL / `pg` calls) or
 * camelCase (a hypothetical Drizzle `pacingLedger` schema export, mirroring
 * MESSAGE_JOBS_TOKEN in single-claim-lib.ts). Patterns below only count as a
 * violation when this token also appears in the same matched span - see
 * `hasCounterColumnWrite`. Without that co-occurrence requirement, matching
 * any of the four bare column names would risk tripping on an unrelated
 * table that happens to share a column name.
 */
const PACING_LEDGER_TOKEN = /\bpacing_ledger\b|\bpacingLedger\b/;

/** Alternation of the four tracked column names, used inside the bounded-gap patterns below. */
const COLUMN_ALTERNATION = RESERVE_COUNTER_COLUMNS.join('|');

/**
 * Whitespace/quote resilient, ANY CASE: matches `UPDATE ... SET ...`
 * followed later in the same string/template literal (or the same raw
 * `.sql` file) by one of the four tracked columns being assigned a value -
 * `consumed_count = ...`, `sent_this_hour=...`, etc. The gap between `SET`
 * and the column assignment is clause-bounded with `(?:(?!\bWHERE\b)[^;])*?`
 * (never crosses a `WHERE` keyword or a `;` statement terminator) - same
 * reasoning as single-claim-lib.ts's LITERAL_STATUS_PATTERN: a legitimate
 * UPDATE that merely reads one of these columns in a WHERE predicate must
 * never be confused with a write. The RHS is intentionally unconstrained
 * (`[^,;]+` up to the next comma/semicolon) - unlike the single-claim guard
 * (which only cares about ONE specific literal value, `'processing'`), this
 * guard bans writing these columns to ANY value at all, so the assignment's
 * right-hand side is not pattern-matched, only its presence.
 */
export const COLUMN_WRITE_PATTERN = new RegExp(
  `(?<!\\bFOR\\s)(?<!\\bFOR\\s+NO\\s+KEY\\s)\\bUPDATE\\b[^;]*?\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\b(?:${COLUMN_ALTERNATION})\\s*=`,
  'i',
);

/**
 * P03-close-style sanitizer (twin of single-claim-lib.ts's
 * SANITIZE_SPAN_PATTERN): neutralizes `;` characters inside a SQL
 * single-quoted string literal or a `--` line comment before
 * COLUMN_WRITE_PATTERN's `[^;]*?`-bounded gaps run over `text`, so neither
 * shape can truncate the bounded gap and let a real second-write UPDATE
 * slip past undetected.
 */
const SANITIZE_SPAN_PATTERN = /--[^\n]*|'(?:[^']|'')*'/g;

export function sanitizeForBoundedScan(text: string): string {
  return text.replace(SANITIZE_SPAN_PATTERN, (span) =>
    span.startsWith('--') ? ' '.repeat(span.length) : span.replace(/;/g, ' '),
  );
}

/**
 * True when `text` contains the banned UPDATE...SET...<column>= shape AND
 * names pacing_ledger/pacingLedger - same co-occurrence discipline as
 * single-claim-lib.ts's hasLiteralOrParamStatusWrite.
 */
export function hasCounterColumnWrite(text: string): boolean {
  if (!PACING_LEDGER_TOKEN.test(text)) return false;
  return COLUMN_WRITE_PATTERN.test(sanitizeForBoundedScan(text));
}

/**
 * Drizzle ORM equivalent - a `pacingLedger` table's `update(...).set({...})`
 * call with one of the four tracked columns as a top-level key, literal or
 * variable value, chained directly or via a variable binding. Brace-balanced
 * (never a naive `[^}]*` hole) and binding-aware, mirroring
 * findDrizzleSecondClaimSetBrace in single-claim-lib.ts exactly - see that
 * function's doc comment for the nested-object and split-builder rationale
 * this reuses unchanged, just retargeted at pacingLedger + the four columns
 * instead of messageJobs + status.
 */
const DRIZZLE_CHAIN_SET_OBJECT_PATTERN = /\bupdate\s*\(\s*pacingLedger\s*\)[^;]*?\.set\s*\(\s*\{/gi;

const DRIZZLE_BINDING_PATTERN =
  /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=[^;]*?\bupdate\s*\(\s*pacingLedger\s*\)/gi;

function objectLiteralHasTopLevelColumnKey(text: string, openBraceIndex: number): boolean {
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
  const keyPattern = new RegExp(`\\b(?:${COLUMN_ALTERNATION})\\s*:`);
  return keyPattern.test(topLevelText);
}

export function findDrizzleSecondReserveSetBrace(content: string): number | undefined {
  const chainPattern = new RegExp(
    DRIZZLE_CHAIN_SET_OBJECT_PATTERN.source,
    DRIZZLE_CHAIN_SET_OBJECT_PATTERN.flags,
  );
  let match: RegExpExecArray | null;
  while ((match = chainPattern.exec(content)) !== null) {
    const braceIndex = match.index + match[0].length - 1;
    if (objectLiteralHasTopLevelColumnKey(content, braceIndex)) return braceIndex;
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
      if (objectLiteralHasTopLevelColumnKey(content, braceIndex)) return braceIndex;
    }
  }

  return undefined;
}

/**
 * Banned-identifier scan (phase-file requirement, folded into this guard -
 * see check-single-reserve.ts's own header for why `check-no-forbidden-
 * mechanism.ts` does not exist and this lives here instead). Reuses
 * `BANNED_IDENTIFIER_LABEL` above (already built by concatenation, never a
 * contiguous literal) so this file's own source text does not trip its own
 * pattern (the same OFFSET_WORD self-scan trap `check-copy.ts`/
 * `check-sql-lint.ts` document for their own banned tokens) - and so the
 * banned token is spelled out in exactly one place in this file.
 */
export function bannedIdentifierPattern(): RegExp {
  return new RegExp(`\\b${BANNED_IDENTIFIER_LABEL}\\b`, 'g');
}

export function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// Comment-stripping + literal-span helpers are shared with the single-claim
// guard - re-exported here (not duplicated) so both guards' sanitization
// behaviour can never silently drift apart.
export { stripComments, literalSpans } from './single-claim-spans.js';
