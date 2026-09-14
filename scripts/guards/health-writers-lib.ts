/**
 * health-writers-lib.ts (P16 Unit E, step 10) - pattern/sanitizer half of
 * check-health-writers.ts, split out for the max-lines cap, mirroring
 * single-reserve-lib.ts's own structure closely: a bounded `UPDATE ... SET
 * ... <column> =` gap pattern, co-occurrence-gated on the owning table name,
 * SQL-comment/string-literal sanitized before the bounded gap runs.
 *
 * TWO independent tracked column groups, because they live on two different
 * tables and have two different pinned allow-lists (see check-health-writers.ts):
 *   - `whatsapp_instances.health_state`
 *   - `instance_pacing_state.health_score` / `instance_pacing_state.health_band`
 */

export interface SourceFile {
  path: string;
  content: string;
}

export const FORBIDDEN_HEALTH_STATE_MESSAGE =
  'check-health-writers: only the pinned whatsapp_instances.health_state writer allow-list may ' +
  'write that column - core invariant 3 (idempotency at the storage layer via a single writer, ' +
  'no second uncoordinated authority over the same state).';

export const FORBIDDEN_HEALTH_BAND_MESSAGE =
  'check-health-writers: only modules/pacing/health/** and the pinned engine/pacing config-service ' +
  'writer may write instance_pacing_state.health_score/health_band - core invariant 3 (idempotency ' +
  'at the storage layer via a single writer, no second uncoordinated authority over the same state).';

const WHATSAPP_INSTANCES_TOKEN = /\bwhatsapp_instances\b/;
const INSTANCE_PACING_STATE_TOKEN = /\binstance_pacing_state\b/;

/** Whitespace/quote resilient, ANY CASE - same bounded-gap shape as single-reserve-lib.ts's COLUMN_WRITE_PATTERN, never crossing a WHERE keyword or a `;` statement terminator. */
export const HEALTH_STATE_WRITE_PATTERN = new RegExp(
  `(?<!\\bFOR\\s)(?<!\\bFOR\\s+NO\\s+KEY\\s)\\bUPDATE\\b[^;]*?\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\bhealth_state\\s*=`,
  'i',
);

export const HEALTH_BAND_WRITE_PATTERN = new RegExp(
  `(?<!\\bFOR\\s)(?<!\\bFOR\\s+NO\\s+KEY\\s)\\bUPDATE\\b[^;]*?\\bSET\\b(?:(?!\\bWHERE\\b)[^;])*?\\b(?:health_score|health_band)\\s*=`,
  'i',
);

/** Same P03-close-style sanitizer as single-reserve-lib.ts - neutralizes `;` inside a string literal or `--` comment before the bounded gaps above run. */
const SANITIZE_SPAN_PATTERN = /--[^\n]*|'(?:[^']|'')*'/g;

export function sanitizeForBoundedScan(text: string): string {
  return text.replace(SANITIZE_SPAN_PATTERN, (span) =>
    span.startsWith('--') ? ' '.repeat(span.length) : span.replace(/;/g, ' '),
  );
}

/** True when `text` writes `whatsapp_instances.health_state` (co-occurrence-gated on the table name, same discipline as single-reserve-lib.ts's hasCounterColumnWrite). */
export function hasHealthStateWrite(text: string): boolean {
  if (!WHATSAPP_INSTANCES_TOKEN.test(text)) return false;
  return HEALTH_STATE_WRITE_PATTERN.test(sanitizeForBoundedScan(text));
}

/** True when `text` writes `instance_pacing_state.health_score` or `.health_band`. */
export function hasHealthBandWrite(text: string): boolean {
  if (!INSTANCE_PACING_STATE_TOKEN.test(text)) return false;
  return HEALTH_BAND_WRITE_PATTERN.test(sanitizeForBoundedScan(text));
}

export function lineOfIndex(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

// Comment-stripping + literal-span helpers are shared with the single-claim
// guard - re-exported here (not duplicated) so sanitization behaviour can
// never silently drift apart across guards.
export { stripComments, literalSpans } from './single-claim-spans.js';
