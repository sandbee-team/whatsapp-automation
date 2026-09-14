import type { TenantDb } from '@wp/db';
import {
  backoff,
  classify,
  isGroupJid,
  resolvePriceKey,
  type ProviderErrorLike,
  type Rng,
} from '@wp/domain';
import { chargeSend, resolveRateMinor } from '../../modules/wallet/index.js';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';
import type { WalletMetricsHandles } from '../../platform/metrics/wallet-metrics.js';
import type { SendOutcome, TransportSendError } from '../../provider/provider.types.js';
import { deliveryEventId, writeDeliveryEvent } from './delivery-event.js';
import { stampCampaignRecipientSent, writeSendFrequencyBucket } from './result-ack-side-effects.js';
import {
  assertJobRowTouched,
  markAttempt,
  SendAttemptRowMissing,
} from './result-attempt-outcome.js';
import { PAUSE_REASON_BY_CLASS, pauseInstanceForResult } from './result-pause.js';
import {
  isRetryBudgetExhausted,
  writeRequeueForPause,
  writeTerminalByExhaustion,
} from './result-retry-budget.js';
import { resolveTerminalFailure } from './result-terminal.js';

// Re-exported so this module's public surface stays unchanged (both live in
// their own sibling file - max-lines split / import-boundary reasons).
export { ClaimLostDuringSend, SendAttemptRowMissing } from './result-attempt-outcome.js';
export { PAUSE_REASON_BY_CLASS } from './result-pause.js';

/**
 * result.ts (P11 Unit U4, step 7) - the blueprint's normative pseudocode:
 * `send_attempts` state write, then the `message_jobs` outcome UPDATE
 * (`id` alone, never `created_at` - see `dispatch.ts`'s own doc for why). A
 * zero-row outcome UPDATE means claim lost during send: `deps.onClaimLost`
 * fires, the OUTCOME stays on the already-committed `send_attempts` row.
 *
 * Failures route through `@wp/domain`'s `classify()`:
 *   RETRY_BACKOFF   -> requeue, UNLESS `isRetryBudgetExhausted` (result-
 *                      retry-budget.ts) - then terminal instead.
 *   FAIL_PERMANENT  -> status='failed' (`result-terminal.ts`, also the P24
 *                      `group_forbidden` hook).
 *   PAUSE_INSTANCE  -> pause the instance (result-pause.ts) AND requeue
 *                      without scheduling a retry - NEVER budget-exhausted:
 *                      a resume releases the job, not a retry ceiling.
 *   RECONCILE       -> not reachable from this phase's inputs; an unmapped
 *                      category resolves PAUSE_INSTANCE (classify()'s doc).
 *
 * TWO-TRANSACTION CRASH WINDOW (documented not collapsed): a crash between
 * the two commits leaves `send_attempts.state IN ('acked','failed')` +
 * `message_jobs.status = 'processing'` - the attempt row is AUTHORITATIVE; a
 * reaper MUST reconcile the job FROM it and MUST NEVER requeue (double-send
 * risk) - `result-crash-window.integration.test.ts` fixtures this state.
 */

export interface ResolveAckInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
  outcome: SendOutcome;
  /** `message_jobs.payload_kind` - feeds `resolvePriceKey` for the wallet debit. */
  payloadKind: string;
  /** `message_jobs.recipient_hash` - null for a `@g.us` recipient or a pre-P14 row; the send-frequency bucket write skips entirely when null. */
  recipientHash?: Buffer | null;
  /** `message_jobs.recipient_jid` - `NOT NULL` on `message_jobs`; required here too so the group/individual pricing decision can never silently default. Also gates the P24 group-sent metric. */
  recipientJid: string;
  /** `message_jobs.campaign_id` - the `campaign_recipients` sent-stamp runs only when non-null. */
  campaignId?: string | null;
}

export interface ResolveFailureInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
  attempts: number;
  maxAttempts: number;
  error: TransportSendError;
  /** `message_jobs.recipient_jid` - `NOT NULL` on `message_jobs`; REQUIRED here (P24 CRITICAL 1 fix) so a caller can never silently omit it and skip the group-only hook/metric in `resolveTerminalFailure` - the exact class of bug that let a production `group_forbidden` terminal failure through `send-loop.ts` without ever running the disable hook. */
  recipientJid: string;
}

export interface ResultDeps {
  tenantDb: TenantDb;
  rng: Rng;
  onClaimLost?: () => void;
  walletMetrics?: Pick<WalletMetricsHandles, 'incDebit'>;
}

/**
 * Step 7's ack path: sent_at, one message_wa_ids row, a 'sent'
 * delivery_events row, and exactly one wallet debit.
 *
 * TWO SEPARATE `withTenant` transactions, deliberately - NOT one: the
 * attempt-state write (`markAttempt`) commits FIRST, on its own, so a
 * zero-row job-outcome update in the SECOND transaction can throw
 * `ClaimLostDuringSend` without rolling back the attempt row along with it
 * ("leave the outcome on the attempt row" only holds once that write has
 * survived past its own COMMIT). `attemptId: null` (zero rows) means no
 * `send_attempts` row ever committed, so `SendAttemptRowMissing` throws
 * BEFORE the second transaction and before any job/money write; the
 * reaper's no-attempt -> requeue contract is the recovery, not a write here.
 *
 * The job-outcome UPDATE is `chargeSend`'s own `debit-send` chain
 * (`modules/wallet/charge.js`) - its first CTE performs the SAME
 * `status='sent'` UPDATE, then charges the wallet off that UPDATE's own
 * `RETURNING` - exactly ONE `status = 'sent'` writer remains. `chargeSend`
 * runs FIRST (holds the wallet row lock for the rest of the tx).
 */
export async function resolveAck(input: ResolveAckInput, deps: ResultDeps): Promise<void> {
  const { attemptId } = await deps.tenantDb.withTenant(input.clientId, (tx) =>
    markAttempt(tx, {
      clientId: input.clientId,
      jobId: input.jobId,
      attemptNo: input.attemptNo,
      state: 'acked',
      providerMsgId: input.outcome.providerMsgId,
    }),
  );
  if (attemptId === null) {
    throw new SendAttemptRowMissing(input.jobId, input.attemptNo);
  }

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const priceKey = resolvePriceKey({
      payloadKind: input.payloadKind,
      recipientJid: input.recipientJid,
    });
    const rateMinor = await resolveRateMinor(tx, input.clientId, priceKey);
    const charge = await chargeSend(tx, {
      attemptId,
      jobId: input.jobId,
      leaseId: input.leaseId,
      clientId: input.clientId,
      priceKey,
      rateMinor,
    });
    assertJobRowTouched(charge.jobRows, input.jobId, deps.onClaimLost);

    if (input.campaignId !== undefined && input.campaignId !== null) {
      await stampCampaignRecipientSent(tx, {
        clientId: input.clientId,
        jobId: input.jobId,
        chargedMinor: charge.seq !== null ? rateMinor : null,
      });
    }

    await tx.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at)
       VALUES ($1, $2, 'out', $3, $4, $5)
       -- client_id = $1`,
      [
        input.clientId,
        input.instanceId,
        input.outcome.providerMsgId,
        input.jobId,
        input.jobCreatedAt,
      ],
    );

    await writeDeliveryEvent(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      messageJobId: input.jobId,
      messageJobCreatedAt: input.jobCreatedAt,
      eventType: 'sent',
      providerEventId: deliveryEventId(input.instanceId, input.publicId, 'sent', input.attemptNo),
    });

    await writeSendFrequencyBucket(tx, {
      clientId: input.clientId,
      recipientHash: input.recipientHash,
      recipientJid: input.recipientJid,
    });

    if (charge.seq !== null) {
      deps.walletMetrics?.incDebit(priceKey);
    }

    if (isGroupJid(input.recipientJid)) {
      bindGroupsMetrics().incrementGroupSend('sent');
    }
  });
}

function toProviderErrorLike(error: TransportSendError): ProviderErrorLike {
  return { code: error.class, category: error.class };
}

/** Step 7's failure path: routes through classify() -> requeue / terminal-fail / pause. Same two-transaction split as `resolveAck`, same reason. */
export async function resolveFailure(input: ResolveFailureInput, deps: ResultDeps): Promise<void> {
  const retryClass = classify(toProviderErrorLike(input.error));

  await deps.tenantDb.withTenant(input.clientId, (tx) =>
    markAttempt(tx, {
      clientId: input.clientId,
      jobId: input.jobId,
      attemptNo: input.attemptNo,
      state: 'failed',
      errorClass: input.error.class,
    }),
  );

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    if (retryClass === 'FAIL_PERMANENT') {
      await resolveTerminalFailure(
        tx,
        {
          clientId: input.clientId,
          instanceId: input.instanceId,
          jobId: input.jobId,
          jobCreatedAt: input.jobCreatedAt,
          leaseId: input.leaseId,
          attemptNo: input.attemptNo,
          publicId: input.publicId,
          errorClass: input.error.class,
          recipientJid: input.recipientJid,
        },
        { onClaimLost: deps.onClaimLost },
      );
      return;
    }

    if (retryClass === 'PAUSE_INSTANCE') {
      // Never budget-exhausted (module header) - requeue-without-retry.
      const rowCount = await writeRequeueForPause(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        jobId: input.jobId,
        jobCreatedAt: input.jobCreatedAt,
        leaseId: input.leaseId,
        attemptNo: input.attemptNo,
        publicId: input.publicId,
        errorClass: input.error.class,
      });
      assertJobRowTouched(rowCount, input.jobId, deps.onClaimLost);

      const pauseReason = PAUSE_REASON_BY_CLASS[input.error.class] ?? 'unknown_signal';
      await pauseInstanceForResult(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        pauseReason,
      });
      return;
    }

    // RETRY_BACKOFF: exhaustion first (see result-retry-budget.ts's own
    // header for the attemptNo-vs-maxAttempts arithmetic).
    if (isRetryBudgetExhausted(input.attemptNo, input.maxAttempts)) {
      const rowCount = await writeTerminalByExhaustion(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        jobId: input.jobId,
        jobCreatedAt: input.jobCreatedAt,
        leaseId: input.leaseId,
        attemptNo: input.attemptNo,
        publicId: input.publicId,
        errorClass: input.error.class,
      });
      assertJobRowTouched(rowCount, input.jobId, deps.onClaimLost);
      return;
    }

    // Budget remains: requeue with jittered backoff, never failed_at (a
    // retrying job has not failed; last_error_class records the cause).
    const delayMs = backoff(input.attempts, deps.rng);
    const jobUpdate = await tx.query(
      `UPDATE message_jobs SET status = 'queued', last_error_class = $1,
              next_attempt_at = now() + ($2 * interval '1 ms')
        WHERE id = $3 AND lease_id = $4 AND status = 'processing' AND client_id = $5`,
      [input.error.class, delayMs, input.jobId, input.leaseId, input.clientId],
    );
    assertJobRowTouched(jobUpdate.rowCount, input.jobId, deps.onClaimLost);
    await writeDeliveryEvent(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      messageJobId: input.jobId,
      messageJobCreatedAt: input.jobCreatedAt,
      eventType: 'retry_scheduled',
      providerEventId: deliveryEventId(
        input.instanceId,
        input.publicId,
        'retry_scheduled',
        input.attemptNo,
      ),
    });
  });
}
