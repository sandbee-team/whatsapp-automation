import type { TenantQueryable } from '@wp/db';
import { isGroupJid, isTerminalCategory } from '@wp/domain';
import { handleGroupForbidden } from '../../modules/groups/forbidden.public.js';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';
import { deliveryEventId, writeDeliveryEvent } from './delivery-event.js';
import { assertJobRowTouched } from './result-attempt-outcome.js';

/**
 * result-terminal.ts (P11 Unit U4 / P24 Unit U4b, step 7) - the
 * FAIL_PERMANENT outcome's job-outcome write, split out of `result.ts` at the
 * max-lines cap (mechanical extraction, behaviour-identical to the branch it
 * replaces - see `result.ts`'s own module header for the full retry-matrix
 * routing this sits inside), mirroring `result-pause.ts`'s own split for the
 * PAUSE_INSTANCE branch.
 *
 * P24 ADDS the `group_forbidden` hook here (the only behaviour change this
 * split introduces): after the job UPDATE commits its outcome (still inside
 * the SAME transaction `tx` - one commit for job+group+audit+notification),
 * a terminal failure whose error class is `group_forbidden` against a
 * `@g.us` recipient runs `handleGroupForbidden` (`modules/groups`) to
 * disable sending into that ONE group. Every other terminal failure (a DM
 * `invalid_recipient`/`invalid_payload`, or any future terminal class) never
 * reaches that hook - `isTerminalCategory` is checked defensively alongside
 * the direct class/jid check, but `resolveFailure`'s own `classify()` gate
 * already guarantees this function is only called for FAIL_PERMANENT.
 *
 * NEVER writes the instance's own health/pause columns, the per-instance
 * pacing-state row, or the pacing-events table - `handleGroupForbidden`'s
 * own module header carries the same guarantee; this function adds no write
 * of its own beyond the pre-existing job/delivery-event pair. Scanned
 * structurally by `forbidden.integration.test.ts`'s own health-writers check
 * - keep this file's prose free of the literal column/table names.
 */

export interface ResolveTerminalFailureInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attemptNo: number;
  publicId: string;
  errorClass: string;
  /** See `ResolveFailureInput.recipientJid`'s own doc comment (`result.ts`) - required, same reason. */
  recipientJid: string;
}

export interface ResolveTerminalFailureDeps {
  onClaimLost?: () => void;
}

export async function resolveTerminalFailure(
  tx: TenantQueryable,
  input: ResolveTerminalFailureInput,
  deps: ResolveTerminalFailureDeps,
): Promise<void> {
  const jobUpdate = await tx.query(
    `UPDATE message_jobs SET status = 'failed', failed_at = now(), terminal_at = now(),
            last_error_class = $1, cancel_reason = $1
      WHERE id = $2 AND lease_id = $3 AND status = 'processing' AND client_id = $4`,
    [input.errorClass, input.jobId, input.leaseId, input.clientId],
  );
  assertJobRowTouched(jobUpdate.rowCount, input.jobId, deps.onClaimLost);

  await writeDeliveryEvent(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    messageJobId: input.jobId,
    messageJobCreatedAt: input.jobCreatedAt,
    eventType: 'failed',
    providerEventId: deliveryEventId(input.instanceId, input.publicId, 'failed', input.attemptNo),
  });

  const isGroupJob = isGroupJid(input.recipientJid);

  if (
    isGroupJob &&
    isTerminalCategory(input.errorClass) &&
    input.errorClass === 'group_forbidden'
  ) {
    await handleGroupForbidden(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      jobPublicId: input.publicId,
      recipientJid: input.recipientJid,
    });
    return;
  }

  if (isGroupJob) {
    bindGroupsMetrics().incrementGroupSend('failed');
  }
}
