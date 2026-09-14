/**
 * Guard decision (P14 Unit U2, phase step 8 domain half).
 *
 * The single decision shape a pacing/content guard returns. Terminal-vs-
 * defer (does this deny end the job, or leave it queued for a later
 * retry?) is NEVER duplicated here as a separate field - it always derives
 * from `DENY_REASON_EFFECTS[reason].jobOutcome` (the existing frozen table
 * in `deny-reasons.ts`), so there is exactly one place that can disagree
 * with itself about whether a given reason is terminal.
 */
import type { DenyReason } from './deny-reasons.js';

export type GuardDecision =
  | { ok: true }
  | {
      ok: false;
      reason: DenyReason;
      retryAt: Date | null;
      /** Set only for `BLOCKED_WORD` - the category label, never the matched word. */
      category?: string;
    };
