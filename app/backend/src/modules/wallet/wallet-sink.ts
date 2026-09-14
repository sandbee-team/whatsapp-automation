import type { TenantDb } from '@wp/db';
import type { RepairedSendSink } from '../queue/repaired-send-sink.js';
import { refundSend } from './refund.js';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';

/**
 * wallet-sink.ts (P18 Unit U4) - the real `RepairedSendSink`, replacing
 * `modules/queue/repaired-send-sink.ts`'s counting no-op in production
 * (wired in `roles/api.ts`).
 *
 * `onRepairedSent` is deliberately BEST-EFFORT: `deps.enqueueCharge` (U5's
 * concern - not supplied here) is called inside try/catch, and a failure is
 * logged at warn with ONLY `{ client_id, send_attempt_id }` (never
 * `external_ref`/phone/message body) and swallowed. Correctness for the
 * repaired-charge path rests on the debit guard plus the reconciler's own
 * check B, not on this call succeeding.
 *
 * `onReconciledLost` runs `refundSend` inside its own `withTenant`
 * transaction - the IDEMPOTENT FALLBACK. The PRIMARY refund runs
 * in-transaction from `modules/queue/unresolved.service.ts#retryUnresolved`
 * (ADR 0038 S5); this call is what a `blocked_needs_review` job never routed
 * through `retryUnresolved` (a future non-human path, or a replay after a
 * partial failure) still reaches - `refund-send.sql`'s guard makes a second
 * call for the same attempt a correct no-op either way.
 */

export interface WalletRepairedSendSinkDeps {
  tenantDb: TenantDb;
  enqueueCharge?: (item: { clientId: string; attemptId: string }) => Promise<void>;
  metrics?: Pick<WalletMetricsHandles, 'incRefund'>;
  logger?: { warn(meta: object, msg: string): void };
}

export function createWalletRepairedSendSink(deps: WalletRepairedSendSinkDeps): RepairedSendSink {
  return {
    async onRepairedSent(attemptId: string, clientId: string): Promise<void> {
      try {
        await deps.enqueueCharge?.({ clientId, attemptId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.logger?.warn(
          { client_id: clientId, send_attempt_id: attemptId },
          `wallet-sink: onRepairedSent enqueueCharge failed, best-effort only: ${message}`,
        );
      }
    },
    async onReconciledLost(attemptId: string, clientId: string): Promise<void> {
      await deps.tenantDb.withTenant(clientId, (tx) =>
        refundSend(tx, { clientId, attemptId }, { metrics: deps.metrics }),
      );
    },
  };
}
