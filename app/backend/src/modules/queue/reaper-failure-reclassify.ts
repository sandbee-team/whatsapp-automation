import type { TenantQueryable } from '@wp/db';
import { backoff, classify, type ProviderErrorLike, type Rng } from '@wp/domain';
import {
  isRetryBudgetExhausted,
  type TerminalByExhaustionInput,
} from '../../engine/queue/result-retry-budget.js';
import { PAUSE_REASON_BY_CLASS, pauseInstanceForResult } from '../../engine/queue/result-pause.js';
import { deliveryEventId, writeDeliveryEvent } from '../../engine/queue/delivery-event.js';
import type { ReapedRow } from './reaper.js';

/**
 * reaper-failure-reclassify.ts (P12 C1 review, CRITICAL finding 2) - the
 * app-level re-drive for a `failed` `send_attempts` row the reaper's SQL
 * (migration 0029) moved to `needs_reconcile` WITHOUT deciding its
 * disposition. `@wp/domain`'s `classify()` is reused verbatim (never
 * reimplemented) to make the SAME terminal / retry / pause decision
 * `result.ts#resolveFailure` would have made had the crash not happened -
 * `isRetryBudgetExhausted`, `backoff`, `pauseInstanceForResult`, and
 * `PAUSE_REASON_BY_CLASS` are all IMPORTED from their existing owners, not
 * copied. `PAUSE_REASON_BY_CLASS`/`pauseInstanceForResult` are imported from
 * `result-pause.ts` specifically, NEVER from `result.ts` itself:
 * `result.ts` transitively imports `provider/provider.types.js`
 * (`SendOutcome`/`TransportSendError`), and `cron-loop-shape.test.ts`'s
 * structural boundary forbids the cron process's import graph (this module
 * runs inside `runOneReaperSweep`, driven by `cron-wiring.ts`) from ever
 * reaching `provider/**`, even via a type-only import - verified live: an
 * earlier version of this file imported `PAUSE_REASON_BY_CLASS` from
 * `result.ts` and broke that exact test.
 *
 * The one thing genuinely new here (not reusable from `result.ts` as-is) is
 * the job-outcome UPDATE's WHERE shape: `result.ts`'s writes are guarded by
 * `status = 'processing' AND lease_id = $n` (the live-lease-holder
 * precondition for an in-flight send). By the time this module runs, the
 * reaper's own definer function has ALREADY moved the job to
 * `needs_reconcile` and cleared its lease - there is no lease to guard
 * against, and the precondition this module needs is simply "still
 * needs_reconcile, still this job" (idempotent re-run safety - a second
 * sweep of the same job is a zero-row no-op here for the same reason
 * `reaper.ts`'s own `acked` repair is idempotent). `send_attempts.state` is
 * NOT rewritten here - migration 0027/0029's SQL already left it `failed`,
 * durably, before this module ever runs (the outcome is authoritative on
 * the attempt row, unchanged from the crash-window doc in `result.ts`).
 *
 * PAUSE_INSTANCE is never subject to budget exhaustion (same rule as
 * `result.ts`'s own header) - the instance pause holds the job; a user
 * resume releases it, not a retry timer or an attempt-count ceiling.
 */

export interface ReclassifyFailureDeps {
  rng: Rng;
}

export type ReclassifyOutcome = 'terminal' | 'paused' | 'retry_scheduled';

/**
 * Re-drives one `needs_reconcile` job whose matched attempt crashed in
 * `failed` state. Requires `row.errorClass`/`row.sendAttemptNo` (both
 * present for every `failed`-branch row - `wp_reap_expired_leases` only
 * ever emits `error_class` alongside a `failed` attempt_state) and
 * `row.maxAttempts` (now projected by migration 0029). Throws if any of
 * these are missing - fail loud, never guess a classification.
 */
export async function reclassifyReapedFailure(
  tx: TenantQueryable,
  row: ReapedRow,
  publicId: string,
  deps: ReclassifyFailureDeps,
): Promise<ReclassifyOutcome> {
  if (row.errorClass === null || row.sendAttemptNo === null || row.maxAttempts === null) {
    throw new Error(
      `reclassifyReapedFailure: attempt_state='failed' but error_class/send_attempt_no/max_attempts missing for job ${row.messageJobId}`,
    );
  }

  const errorLike: ProviderErrorLike = { code: row.errorClass, category: row.errorClass };
  const retryClass = classify(errorLike);
  const attemptNo = row.sendAttemptNo;

  if (retryClass === 'FAIL_PERMANENT') {
    await writeReclassifiedTerminal(tx, row, publicId, attemptNo, row.errorClass);
    return 'terminal';
  }

  if (retryClass === 'PAUSE_INSTANCE') {
    await writeReclassifiedRequeueForPause(tx, row, publicId, attemptNo, row.errorClass);
    const pauseReason = PAUSE_REASON_BY_CLASS[row.errorClass] ?? 'unknown_signal';
    await pauseInstanceForResult(tx, {
      clientId: row.clientId,
      instanceId: row.instanceId,
      pauseReason,
    });
    return 'paused';
  }

  // RETRY_BACKOFF: exhaustion first, same arithmetic result.ts owns.
  if (isRetryBudgetExhausted(attemptNo, row.maxAttempts)) {
    await writeReclassifiedTerminal(tx, row, publicId, attemptNo, row.errorClass);
    return 'terminal';
  }

  const delayMs = backoff(row.sendAttemptNo, deps.rng);
  await tx.query(
    `UPDATE message_jobs SET status = 'queued', last_error_class = $1,
            next_attempt_at = now() + ($2 * interval '1 ms')
      WHERE id = $3 AND status = 'needs_reconcile' AND client_id = $4`,
    [row.errorClass, delayMs, row.messageJobId, row.clientId],
  );
  await writeDeliveryEvent(tx, {
    clientId: row.clientId,
    instanceId: row.instanceId,
    messageJobId: row.messageJobId,
    messageJobCreatedAt: row.messageJobCreatedAt,
    eventType: 'retry_scheduled',
    providerEventId: deliveryEventId(row.instanceId, publicId, 'retry_scheduled', attemptNo),
  });
  return 'retry_scheduled';
}

/** Same terminal shape as `result-retry-budget.ts#writeTerminalByExhaustion` / `result.ts`'s FAIL_PERMANENT branch, re-scoped to `needs_reconcile` (no lease to guard). */
async function writeReclassifiedTerminal(
  tx: TenantQueryable,
  row: ReapedRow,
  publicId: string,
  attemptNo: number,
  errorClass: string,
): Promise<void> {
  const input: Omit<TerminalByExhaustionInput, 'leaseId'> = {
    clientId: row.clientId,
    instanceId: row.instanceId,
    jobId: row.messageJobId,
    jobCreatedAt: row.messageJobCreatedAt,
    attemptNo,
    publicId,
    errorClass,
  };
  await tx.query(
    `UPDATE message_jobs SET status = 'failed', failed_at = now(), terminal_at = now(),
            last_error_class = $1, cancel_reason = $1
      WHERE id = $2 AND status = 'needs_reconcile' AND client_id = $3`,
    [input.errorClass, input.jobId, input.clientId],
  );
  await writeDeliveryEvent(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    messageJobId: input.jobId,
    messageJobCreatedAt: input.jobCreatedAt,
    eventType: 'failed',
    providerEventId: deliveryEventId(input.instanceId, input.publicId, 'failed', input.attemptNo),
  });
}

/** Same requeue-without-a-retry-timer shape as `result-retry-budget.ts#writeRequeueForPause`, re-scoped to `needs_reconcile`. */
async function writeReclassifiedRequeueForPause(
  tx: TenantQueryable,
  row: ReapedRow,
  publicId: string,
  attemptNo: number,
  errorClass: string,
): Promise<void> {
  await tx.query(
    `UPDATE message_jobs SET status = 'queued', last_error_class = $1
      WHERE id = $2 AND status = 'needs_reconcile' AND client_id = $3`,
    [errorClass, row.messageJobId, row.clientId],
  );
  await writeDeliveryEvent(tx, {
    clientId: row.clientId,
    instanceId: row.instanceId,
    messageJobId: row.messageJobId,
    messageJobCreatedAt: row.messageJobCreatedAt,
    eventType: 'paused_hold',
    providerEventId: deliveryEventId(row.instanceId, publicId, 'paused_hold', attemptNo),
  });
}
