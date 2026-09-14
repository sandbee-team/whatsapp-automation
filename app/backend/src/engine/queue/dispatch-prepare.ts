import type { TenantQueryable } from '@wp/db';
import { computeContentHash } from './content-hash.js';
import { deliveryEventId, writeDeliveryEvent } from './delivery-event.js';

/**
 * dispatch-prepare.ts (P11 Unit U4, step 6 origin; split out P34 Unit B for
 * `dispatch.ts`'s max-lines cap - the established split idiom, same
 * reasoning as `dispatch-optout-precheck.ts`'s own header) - step 1's
 * `send_attempts` INSERT + `attempts + 1` UPDATE + `dispatched` delivery
 * event, all inside the caller's already-open transaction.
 */

export interface DispatchInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  attempts: number;
  recipientJid: string;
  payloadKind: string;
  payload: Record<string, unknown>;
  publicId: string;
  /** Must equal `instance_lease_state.current_fence` (same contract as `SendLoopDeps.fence`/`ClaimOneInput.fence`) - written onto the `send_attempts` row (MAJOR 8 fix) so a reaper (P12) can tell whether an in-flight attempt belongs to a superseded session generation. */
  fence: number | bigint;
  /** `message_jobs.recipient_hash` (P14) - null for `@g.us` or a pre-P14 row; the precheck (`dispatch-optout-precheck.ts`) skips when null. */
  recipientHash: Buffer | null;
  /** `message_jobs.send_origin` (P14) - the precheck also skips `'opt_out_confirmation'`. */
  sendOrigin: string | null;
  /** The claimed job's ORIGINAL pacing reserve, if granted (P14) - required to refund correctly on a precheck cancellation; see `queue.repo.ts#ClaimedJob.pacingReserve`. */
  pacingReserve?: {
    ledgerDate: string;
    gapMs: number;
    isNewConversation: boolean;
    isGroup: boolean;
    isExempt: boolean;
  };
}

/**
 * Thrown when the `attempts = attempts + 1` UPDATE (matched on
 * `id = $1 AND lease_id = $2`) matches zero rows - another worker's fresh
 * claim (`claim-jobs.sql`'s `SET lease_id = gen_random_uuid()`) has already
 * replaced this lease_id, so the caller no longer owns the job. Distinct
 * from `result.ts`'s `ClaimLostDuringSend` on purpose: here nothing has
 * been sent yet and the whole `withTenant` transaction rolls back with it
 * (no send_attempts row survives); that class instead leaves an
 * already-committed attempt-state row in place by design. A NORMAL outcome
 * (another worker owns the job now), never a crash - see `send-loop.ts`'s
 * own catch of this class.
 */
export class ClaimLostBeforeDispatch extends Error {
  constructor(jobId: string) {
    super(
      `dispatch: message_jobs ${jobId} was not held under this lease - claim lost before dispatch`,
    );
    this.name = 'ClaimLostBeforeDispatch';
  }
}

/**
 * Thrown when a replayed `dispatch()` call for the identical
 * `(jobId, attemptNo)` finds its `send_attempts` INSERT already recorded
 * (the `UNIQUE (message_job_id, attempt_no)` backstop, migration 0008).
 * Detected via `ON CONFLICT ... DO NOTHING RETURNING id` + a `rowCount`
 * check, never a try/catch on the raw 23505 (that would abort the open
 * transaction with no savepoint, turning a later COMMIT into a silent
 * ROLLBACK - the same trap `writeDeliveryEvent` avoids).
 */
export class DispatchAlreadyRecorded extends Error {
  constructor(jobId: string, attemptNo: number) {
    super(`dispatch: send_attempts already recorded for job ${jobId} attempt ${String(attemptNo)}`);
    this.name = 'DispatchAlreadyRecorded';
  }
}

/**
 * The CONTENT-HASH wire projection (ADR 0035) - NOT a `WaMessagePayload`
 * (that type no longer has a bare `{kind:'media', text}` shape; media now
 * carries a resolved stream, built separately by `dispatch-media.ts`).
 * `text` is `payload.text` for a text job, or `payload.caption` for a media
 * job (image/document) - the caption is the only text-shaped field that
 * crosses the transport boundary for a media send, so it is what the hash
 * must cover; a captionless media job hashes with `text: undefined`, same
 * ambiguity ADR 0035 §5 already accepts (ADR 0052 reopens and keeps it).
 */
export function toContentHashProjection(input: DispatchInput): {
  to: string;
  kind: 'text' | 'media';
  text?: string;
} {
  const isMedia = input.payloadKind === 'media';
  const field = isMedia ? input.payload.caption : input.payload.text;
  return {
    to: input.recipientJid,
    kind: isMedia ? 'media' : 'text',
    text: typeof field === 'string' ? field : undefined,
  };
}

export async function prepareAndIncrement(
  tx: TenantQueryable,
  input: DispatchInput,
  attemptNo: number,
  onClaimLost?: () => void,
): Promise<void> {
  // ADR 0035: content_hash covers exactly the wire projection we send, by
  // construction - never `input.payload` (open jsonb, unobservable from an echo).
  const wireProjection = toContentHashProjection(input);
  // ON CONFLICT DO NOTHING RETURNING id, not a try/catch on 23505 (would
  // abort the open transaction with no savepoint - see DispatchAlreadyRecorded's
  // own doc). A replay of the identical (jobId, attemptNo) resolves to zero
  // rows here, never a raw pg error.
  const attemptInsert = await tx.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, content_hash, owner_fence, state, prepared_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'prepared', now())
     ON CONFLICT (message_job_id, attempt_no) DO NOTHING
     RETURNING id
     -- client_id = $1`,
    [
      input.clientId,
      input.instanceId,
      input.jobId,
      input.jobCreatedAt,
      input.leaseId,
      attemptNo,
      computeContentHash({
        jid: wireProjection.to,
        kind: wireProjection.kind,
        text: wireProjection.text,
      }),
      input.fence,
    ],
  );
  if (attemptInsert.rowCount === 0 || attemptInsert.rowCount === null) {
    throw new DispatchAlreadyRecorded(input.jobId, attemptNo);
  }

  // `id` alone (never `created_at` re-bound into a predicate - see module doc).
  const jobUpdate = await tx.query(
    `UPDATE message_jobs SET attempts = attempts + 1
      WHERE id = $1 AND lease_id = $2 AND client_id = $3`,
    [input.jobId, input.leaseId, input.clientId],
  );
  // Zero rows: another worker's fresh claim already replaced this lease_id
  // (see ClaimLostBeforeDispatch's own doc) - rolls back the send_attempts
  // INSERT above with it; the caller must NOT proceed to call the provider.
  if (jobUpdate.rowCount === 0 || jobUpdate.rowCount === null) {
    onClaimLost?.();
    throw new ClaimLostBeforeDispatch(input.jobId);
  }

  await writeDeliveryEvent(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    messageJobId: input.jobId,
    messageJobCreatedAt: input.jobCreatedAt,
    eventType: 'dispatched',
    providerEventId: deliveryEventId(input.instanceId, input.publicId, 'dispatched', attemptNo),
  });
}
