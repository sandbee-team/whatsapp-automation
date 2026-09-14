import type { TenantQueryable } from '@wp/db';
import { deliveryEventId, writeDeliveryEvent } from './delivery-event.js';

/**
 * result-retry-budget.ts (CRITICAL 2 + CRITICAL 4 fix, P11 gate round) -
 * split out of `result.ts` at the max-lines cap: the two job-outcome writes
 * `resolveFailure`'s RETRY_BACKOFF/PAUSE_INSTANCE branch used to share
 * (see `result.ts`'s own module header for the full retry-matrix routing;
 * this file owns only the two writes below, never the classification
 * decision itself).
 *
 * ATTEMPT-BUDGET ARITHMETIC (CRITICAL 2, exact and load-bearing - do not
 * "simplify"): `dispatch.ts`'s `prepareAndIncrement` computes
 * `attemptNo = input.attempts + 1` (the pre-dispatch, claim-time count) and
 * COMMITS `UPDATE message_jobs SET attempts = attempts + 1` BEFORE
 * `result.ts` ever runs (`dispatch.integration.test.ts`'s own
 * `attempts_increments_exactly_once_per_attempt_row` proves the identity:
 * after N dispatch calls, `message_jobs.attempts === N === attemptNo` of
 * the Nth call). So by the time `resolveFailure` is called, the LIVE
 * `message_jobs.attempts` column already equals `input.attemptNo` - NOT
 * `input.attempts` (which `send-loop.ts` populates from `job.attempts` at
 * CLAIM time, one dispatch call stale). Exhaustion must therefore compare
 * `attemptNo`, never `attempts`, against `maxAttempts`:
 *
 *   isRetryBudgetExhausted = attemptNo >= maxAttempts
 *
 * A job with `maxAttempts = N` makes dispatch calls 1..N. At the Nth
 * call's outcome, `attemptNo === N === maxAttempts`, so this predicate
 * fires and the job goes terminal HERE - a dispatch call N+1 never happens,
 * so the live `attempts` column never exceeds N. The DB's own backstop,
 * `mj_attempts_range` (migration 0007: `attempts <= max_attempts + 1`), is
 * never even approached - this app-level guard is strictly tighter than the
 * CHECK, exactly as migration 0025's own header requires ("the app still
 * needs to READ the ceiling to choose the outcome BEFORE writing").
 */
export function isRetryBudgetExhausted(attemptNo: number, maxAttempts: number): boolean {
  return attemptNo >= maxAttempts;
}

export interface TerminalByExhaustionInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
  errorClass: string;
}

/**
 * A `RETRY_BACKOFF`-classified failure whose attempt budget is exhausted:
 * the SAME terminal shape `resolveFailure`'s FAIL_PERMANENT branch writes
 * (`status='failed'`, `failed_at`, `terminal_at`, `last_error_class`,
 * `cancel_reason`) plus a `failed` delivery event - never a `retry_scheduled`
 * one, since no retry is actually happening. Returns the job-outcome
 * UPDATE's `rowCount` so the caller can still run its own
 * `assertJobRowTouched`/`onClaimLost` handling (claim-lost applies here
 * exactly as it does to every other job-outcome write in this module).
 */
export async function writeTerminalByExhaustion(
  tx: TenantQueryable,
  input: TerminalByExhaustionInput,
): Promise<number | null> {
  const jobUpdate = await tx.query(
    `UPDATE message_jobs SET status = 'failed', failed_at = now(), terminal_at = now(),
            last_error_class = $1, cancel_reason = $1
      WHERE id = $2 AND lease_id = $3 AND status = 'processing' AND client_id = $4`,
    [input.errorClass, input.jobId, input.leaseId, input.clientId],
  );
  await writeDeliveryEvent(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    messageJobId: input.jobId,
    messageJobCreatedAt: input.jobCreatedAt,
    eventType: 'failed',
    providerEventId: deliveryEventId(input.instanceId, input.publicId, 'failed', input.attemptNo),
  });
  return jobUpdate.rowCount;
}

export interface RequeueForPauseInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
  errorClass: string;
}

/**
 * PAUSE_INSTANCE's job-row write (CRITICAL 4 fix): requeues the job
 * (`status='queued'`, invariant 5 - never failed, never lost) WITHOUT
 * scheduling a retry timer and WITHOUT `failed_at` (this is not a failure -
 * `last_error_class` alone already records the cause). The instance pause
 * (`result-pause.ts`) is what holds the job; a user-initiated resume is
 * what releases it, not a `next_attempt_at` timer racing ahead of that
 * decision. Writes a `paused_hold` delivery event, never `retry_scheduled`
 * - the durable trail must not claim a retry was scheduled for a restricted
 * message.
 */
export async function writeRequeueForPause(
  tx: TenantQueryable,
  input: RequeueForPauseInput,
): Promise<number | null> {
  const jobUpdate = await tx.query(
    `UPDATE message_jobs SET status = 'queued', last_error_class = $1
      WHERE id = $2 AND lease_id = $3 AND status = 'processing' AND client_id = $4`,
    [input.errorClass, input.jobId, input.leaseId, input.clientId],
  );
  await writeDeliveryEvent(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    messageJobId: input.jobId,
    messageJobCreatedAt: input.jobCreatedAt,
    eventType: 'paused_hold',
    providerEventId: deliveryEventId(
      input.instanceId,
      input.publicId,
      'paused_hold',
      input.attemptNo,
    ),
  });
  return jobUpdate.rowCount;
}
