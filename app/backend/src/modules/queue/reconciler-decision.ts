/**
 * reconciler-decision.ts (P12 Unit U3, step 6) - the PURE decision core of
 * the echo reconciler: given one `needs_reconcile` candidate (from
 * `wp_reconcile_scan_unresolved`, migration 0027) and its unresolved
 * evidence rows (from `message_wa_ids WHERE message_id IS NULL`), decides
 * which of four outcomes applies. No I/O, no clock read inside this module -
 * `nowMs` is always injected (this repo has no in-memory DB fake, so
 * `reconciler.ts`'s DB-driving wrapper is proved by the integration suite;
 * this decision table is proved by `reconciler.test.ts` alone).
 *
 * The four outcomes, verbatim from the phase file's step 6 + ADR 0035 §7's
 * fail-safe bias:
 *   - `resolve`   - exactly one evidence row matches within tolerance AND
 *                    `siblingInflightCount === 0` (no other in-flight
 *                    attempt on this instance shares the hash). The ONE
 *                    evidence row to use is returned.
 *   - `ambiguous` - `siblingInflightCount > 0` (another in-flight attempt
 *                    shares this content hash) OR more than one evidence row
 *                    matches within tolerance. Resolves NONE - core
 *                    invariant 2, an unclear state is never guessed at.
 *   - `expired`   - the candidate's `dispatchedAt` is older than
 *                    `TIMING.reconcileWindowMs` and no evidence matched:
 *                    window exhausted, no automatic requeue, human review.
 *   - `wait`      - no evidence yet, but still inside the window: do nothing
 *                    this cycle (a later sweep may find the echo).
 */

export type ReconcileOutcome =
  | { kind: 'resolve'; evidenceWaMsgId: string; evidenceObservedAt: Date }
  | { kind: 'ambiguous' }
  | { kind: 'expired' }
  | { kind: 'wait' };

export interface ReconcileCandidate {
  clientId: string;
  instanceId: string;
  contentHash: Buffer;
  dispatchedAt: Date;
  /** From `wp_reconcile_scan_unresolved`'s own aggregate - count of OTHER in-flight `dispatched` attempts on this instance sharing this content hash within the tolerance window. */
  siblingInflightCount: number;
}

export interface UnresolvedEvidenceRow {
  waMsgId: string;
  observedAt: Date;
}

export interface DecideReconciliationInput {
  candidate: ReconcileCandidate;
  /** Unresolved (`message_id IS NULL`) `message_wa_ids` rows for this `(client_id, instance_id, content_hash)`, already tolerance-filtered by the caller's SQL predicate. */
  evidenceRows: readonly UnresolvedEvidenceRow[];
  nowMs: number;
  reconcileWindowMs: number;
}

/** Pure: decides one candidate's outcome. See this module's own header for the four-outcome table. */
export function decideReconciliation(input: DecideReconciliationInput): ReconcileOutcome {
  const { candidate, evidenceRows, nowMs, reconcileWindowMs } = input;

  if (candidate.siblingInflightCount > 0 || evidenceRows.length > 1) {
    return { kind: 'ambiguous' };
  }

  if (evidenceRows.length === 1) {
    const [evidence] = evidenceRows;
    if (evidence) {
      return {
        kind: 'resolve',
        evidenceWaMsgId: evidence.waMsgId,
        evidenceObservedAt: evidence.observedAt,
      };
    }
  }

  const windowExpired = nowMs - candidate.dispatchedAt.getTime() >= reconcileWindowMs;
  return windowExpired ? { kind: 'expired' } : { kind: 'wait' };
}
