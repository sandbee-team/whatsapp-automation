/**
 * repaired-send-sink.ts (P12 Unit U2, step 4; P18 landed - the real sink is
 * `modules/wallet/wallet-sink.ts`). ADR 0019: a repaired send IS charged - a
 * crashed-after-`acked` attempt the reaper resolves to `sent` (contract row
 * 4) already reached the recipient, so the wallet charge for it must fire
 * exactly once, keyed on `send_attempts.id` (never re-derived from a job id
 * - "P18 will scan for repairs" was explicitly rejected by the scope
 * delta). `onReconciledLost` is the mirror for the reconciler's
 * `needs_reconcile -> reconciled_lost` branch (a `refund_send` keyed
 * `(send_attempt_id, 'refund_send')`, only if a `debit_send` guard exists) -
 * both methods now also take `clientId` (RLS-scoped wallet writes need the
 * tenant, not just the attempt id).
 *
 * No wallet import, no wallet table reference, no money arithmetic in this
 * file - `wallet-sink.ts` owns the real implementation.
 */

export interface RepairedSendSink {
  /** A repaired attempt that IS charged (contract row 4: acked -> sent). Keyed on send_attempts.id. */
  onRepairedSent(attemptId: string, clientId: string): Promise<void>;
  /** A repaired attempt resolved to reconciled_lost - the refund-eligible mirror. Keyed on send_attempts.id. */
  onReconciledLost(attemptId: string, clientId: string): Promise<void>;
}

/** Counting no-op: records every call (by attemptId, plus clientId for onRepairedSent) so tests can assert exactly-once, without touching money. */
export interface CountingRepairedSendSink extends RepairedSendSink {
  readonly repairedSentCalls: string[];
  readonly repairedSentClientIds: string[];
  readonly reconciledLostCalls: string[];
}

export function createCountingNoOpRepairedSendSink(): CountingRepairedSendSink {
  const repairedSentCalls: string[] = [];
  const repairedSentClientIds: string[] = [];
  const reconciledLostCalls: string[] = [];

  return {
    repairedSentCalls,
    repairedSentClientIds,
    reconciledLostCalls,
    async onRepairedSent(attemptId: string, clientId: string): Promise<void> {
      repairedSentCalls.push(attemptId);
      repairedSentClientIds.push(clientId);
    },
    async onReconciledLost(attemptId: string): Promise<void> {
      reconciledLostCalls.push(attemptId);
    },
  };
}
