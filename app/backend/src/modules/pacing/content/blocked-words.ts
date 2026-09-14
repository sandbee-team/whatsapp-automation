import type { TenantQueryable } from '@wp/db';
import {
  matchBlockedWord,
  matchPreparedBlockedWord,
  prepareBlockedWordEntries,
  PLATFORM_BLOCKED_WORDS,
  type GuardDecision,
  type PreparedBlockedWordEntry,
} from '@wp/domain';

/**
 * blocked-words.ts (P14 Unit U5, phase step 6; MINOR 14 FIX, P14 review-fix
 * F2) - `evaluateBlockedWords`: the platform blocked-word list
 * (`@wp/domain`'s `PLATFORM_BLOCKED_WORDS`, code-owned, never rows) UNIONED
 * with this tenant's own additions (`tenant_blocked_words`, mapped to
 * category `'tenant'` - a tenant-added word never carries the platform's
 * finer categories, since it has no platform taxonomy entry of its own).
 *
 * `matchBlockedWord` (see its own doc comment) returns ONLY a category,
 * never the matched word/phrase - this evaluator forwards that category
 * unchanged into `GuardDecision.category` and NOWHERE ELSE (no log line,
 * no thrown error) ever carries the matched word, so a caller can never
 * build a filter-tuning oracle by probing which exact phrase trips the
 * filter.
 *
 * MINOR 14: `evaluateBlockedWords` (standalone signature, unchanged) fetches
 * the tenant's own rows AND compiles every regex fresh on every call - fine
 * for a single evaluation, wasteful when a caller evaluates many jobs per
 * pass (one instance/client per `claimAndReserve` pass - the tenant's
 * `tenant_blocked_words` rows cannot change mid-pass). `fetchBlockedWordEntries`
 * + `evaluateBlockedWordsPrepared` let a per-pass caller (`pipeline.ts`) fetch
 * and compile ONCE, then reuse the prepared entries for every job in that
 * pass.
 */

export interface EvaluateBlockedWordsInput {
  clientId: string;
  body: string;
}

/** Fetches this tenant's own `tenant_blocked_words` rows and returns the FULL platform+tenant entry list, already compiled (`@wp/domain`'s `prepareBlockedWordEntries`) - call ONCE per `claimAndReserve` pass, never per job. */
export async function fetchBlockedWordEntries(
  tx: TenantQueryable,
  clientId: string,
): Promise<PreparedBlockedWordEntry[]> {
  const tenantRows = await tx.query<{ word: string }>(
    `SELECT word FROM tenant_blocked_words WHERE client_id = $1`,
    [clientId],
  );
  const entries = [
    ...PLATFORM_BLOCKED_WORDS,
    ...tenantRows.rows.map((row) => ({ word: row.word, category: 'tenant' })),
  ];
  return prepareBlockedWordEntries(entries);
}

/** Evaluates `body` against ALREADY-PREPARED entries (`fetchBlockedWordEntries`) - no DB read, no regex compilation. The per-job evaluator a pass-scoped caller should use. */
export function evaluateBlockedWordsPrepared(
  body: string,
  prepared: readonly PreparedBlockedWordEntry[],
): GuardDecision {
  const match = matchPreparedBlockedWord(body, prepared);
  if (match) {
    return { ok: false, reason: 'BLOCKED_WORD', retryAt: null, category: match.category };
  }
  return { ok: true };
}

/** Standalone signature (unchanged) - fetches + compiles fresh on every call. Kept for callers evaluating a single job in isolation (tests, one-off checks); a per-pass caller should use `fetchBlockedWordEntries` + `evaluateBlockedWordsPrepared` instead (MINOR 14). */
export async function evaluateBlockedWords(
  tx: TenantQueryable,
  input: EvaluateBlockedWordsInput,
): Promise<GuardDecision> {
  const tenantRows = await tx.query<{ word: string }>(
    `SELECT word FROM tenant_blocked_words WHERE client_id = $1`,
    [input.clientId],
  );
  const entries = [
    ...PLATFORM_BLOCKED_WORDS,
    ...tenantRows.rows.map((row) => ({ word: row.word, category: 'tenant' })),
  ];

  const match = matchBlockedWord(input.body, entries);
  if (match) {
    return { ok: false, reason: 'BLOCKED_WORD', retryAt: null, category: match.category };
  }

  return { ok: true };
}
