import { bindQueryParams, loadNamedQuery, type TenantQueryable } from '@wp/db';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';

/**
 * refund.ts (P18 Unit U4) - the reversal half of the guard-first money seam
 * (ADR 0019 S7; ADR 0038 S5), wired over `db/queries/refund-send.sql` (see
 * that file's own header for the full guard-first/lock-order/idempotency
 * contract; this module owns only the two-statement call sequence).
 * `refundSend` runs a `deb` guard-gated no-op when `send_attempt_id` was
 * never actually charged (`debitRows === 0`) - never throws in that case,
 * since in today's flows a `reconciled_lost` attempt was `dispatched` but
 * never `acked`, so it was never debited in the first place. Callers:
 * `modules/wallet/wallet-sink.ts` (the sink's own `onReconciledLost`, the
 * idempotent post-commit fallback) and `modules/queue/unresolved.service.ts`
 * (`retryUnresolved`, the primary in-transaction refund).
 */

export interface RefundResult {
  debitRows: number;
  guardRows: number;
  seq: string | null;
}

export interface RefundSendInput {
  clientId: string;
  attemptId: string;
}

export interface RefundSendDeps {
  metrics?: Pick<WalletMetricsHandles, 'incRefund'>;
}

/**
 * Runs `refund-send` (guard-gated reversal of a `debit_send` charge for
 * `input.attemptId`); when a ledger row was actually written (`seq !==
 * null`), stamps the guard's `ledger_seq` in a second statement (reusing
 * `debit-send.sql`'s `wallet-stamp-guard` with `kind = 'refund_send'`), same
 * transaction, and increments `metrics.incRefund('reconciled_lost')`. A
 * no-op (no debit guard to reverse, or a replayed refund) never throws and
 * never touches metrics.
 */
export async function refundSend(
  tx: TenantQueryable,
  input: RefundSendInput,
  deps: RefundSendDeps = {},
): Promise<RefundResult> {
  const refundQuery = await loadNamedQuery('refund-send', 'refund-send');
  const refundResult = await tx.query<{
    debit_rows: number;
    guard_rows: number;
    seq: string | null;
  }>(
    refundQuery.text,
    bindQueryParams(refundQuery, {
      attempt: input.attemptId,
      client: input.clientId,
    }),
  );
  const row = refundResult.rows[0];
  const result: RefundResult = {
    debitRows: row?.debit_rows ?? 0,
    guardRows: row?.guard_rows ?? 0,
    seq: row?.seq ?? null,
  };

  if (result.seq !== null) {
    const stampQuery = await loadNamedQuery('debit-send', 'wallet-stamp-guard');
    await tx.query(
      stampQuery.text,
      bindQueryParams(stampQuery, {
        seq: result.seq,
        attempt: input.attemptId,
        kind: 'refund_send',
        client: input.clientId,
      }),
    );
    deps.metrics?.incRefund('reconciled_lost');
  }

  return result;
}
