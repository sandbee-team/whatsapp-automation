/**
 * Provider error -> retry class (blueprint "Backoff, retry classes,
 * campaign expansion" section, line ~500):
 *
 *   transient        -> requeue with backoff              -> RETRY_BACKOFF
 *   not_connected     -> requeue, instance degraded         -> RETRY_BACKOFF
 *   rate_limited      -> requeue with retry_after + health  -> RETRY_BACKOFF
 *   invalid_recipient -> failed (terminal)                  -> FAIL_PERMANENT
 *   invalid_payload   -> failed (terminal)                  -> FAIL_PERMANENT
 *   group_forbidden   -> failed (terminal, P16 Unit C)       -> FAIL_PERMANENT
 *   restricted        -> pause the instance                 -> PAUSE_INSTANCE
 *   unknown           -> pause the instance                 -> PAUSE_INSTANCE
 *
 * THE ONE HARD RULE (core invariant 2, fail-safe): any code/category not
 * explicitly in the table below also classifies as PAUSE_INSTANCE - an
 * unrecognized provider error is never silently retried.
 *
 * `category` drives classification; `err.code` is never consulted by
 * `classify` itself - it is carried on `ProviderErrorLike` purely as
 * evidence (recorded on the send-attempt row for audit/debugging), not as a
 * second classification key. `not_connected` and `rate_limited` also carry
 * a health-signal side effect (mark the instance DEGRADED / apply
 * `retry_after`) - that is the P08 caller's responsibility once it exists,
 * not `classify`'s: this function's only job is category -> RetryClass.
 *
 * `table` is an injection point (P08): `classify(err, table)` lets a caller
 * (e.g. the Baileys disconnect-map) classify against an extended category
 * table without forking this function - defaults to the exported
 * `RETRY_CLASS_BY_CATEGORY`. The two hard-pause categories, `restricted` and
 * `unknown`, are non-overridable by design (core invariant 2, fail-safe):
 * `classify` short-circuits to `PAUSE_INSTANCE` for them BEFORE consulting
 * `table` at all, so no injected table - however it maps those keys - can
 * downgrade either category to a retry or a permanent failure.
 *
 * `RetryClass` also has a fourth member, `RECONCILE`, per the design doc's
 * declared surface (`.memory/research/2026-08-25-v1-design-repo-structure.md`
 * §3.3 row 14). The blueprint's retry-class table does not name a category
 * that maps to it today - reconciliation is currently driven by the reaper
 * from `send_attempts.state`, not by a provider error category - so no
 * mapping is seeded here (conservative reading; kept small and honest).
 * P08's Baileys disconnect-map extends the category table it passes in via
 * `table`, without touching `classify` itself.
 */

export type RetryClass = 'RETRY_BACKOFF' | 'PAUSE_INSTANCE' | 'FAIL_PERMANENT' | 'RECONCILE';

/**
 * Minimal structural shape of a provider error, as seen by `classify`.
 * `code` is evidence only (see module doc above) - `category` is what
 * `classify` reads.
 */
export interface ProviderErrorLike {
  code?: string | number;
  category?: string;
}

/** Extensible, data-driven category -> class table. See module doc above. */
export const RETRY_CLASS_BY_CATEGORY: Readonly<Record<string, RetryClass>> = Object.freeze({
  transient: 'RETRY_BACKOFF',
  not_connected: 'RETRY_BACKOFF',
  rate_limited: 'RETRY_BACKOFF',
  invalid_recipient: 'FAIL_PERMANENT',
  invalid_payload: 'FAIL_PERMANENT',
  // P16 Unit C, scope delta § Groups: a @g.us authorisation rejection
  // (not-admin / announce-mode / not-participant) is terminal for that ONE
  // job only - it must never reach the hard-restriction pause path, unlike
  // `restricted`/`unknown` below.
  group_forbidden: 'FAIL_PERMANENT',
  restricted: 'PAUSE_INSTANCE',
  unknown: 'PAUSE_INSTANCE',
});

/**
 * DERIVED, never hand-listed: every category whose `RETRY_CLASS_BY_CATEGORY`
 * value is `'FAIL_PERMANENT'` - currently `invalid_recipient`,
 * `invalid_payload`, `group_forbidden`. Adding a new terminal category means
 * adding it to the table above; this set follows automatically.
 */
export const TERMINAL_CATEGORIES: ReadonlySet<string> = new Set(
  Object.entries(RETRY_CLASS_BY_CATEGORY)
    .filter(([, retryClass]) => retryClass === 'FAIL_PERMANENT')
    .map(([category]) => category),
);

export function isTerminalCategory(category: string | undefined): boolean {
  return category !== undefined && TERMINAL_CATEGORIES.has(category);
}

export function classify(
  err: ProviderErrorLike,
  table: Readonly<Record<string, RetryClass>> = RETRY_CLASS_BY_CATEGORY,
): RetryClass {
  const category = err.category;
  // Hard-pause categories, non-overridable by any injected `table` (core
  // invariant 2) - checked before the table lookup below.
  if (category === 'restricted' || category === 'unknown') {
    return 'PAUSE_INSTANCE';
  }
  if (category !== undefined && Object.hasOwn(table, category)) {
    return table[category] as RetryClass;
  }
  // Fail-safe default: unmapped/unrecognized -> pause, never retry.
  return 'PAUSE_INSTANCE';
}
