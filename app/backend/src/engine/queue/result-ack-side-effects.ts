import type { TenantQueryable } from '@wp/db';

/**
 * result-ack-side-effects.ts - split out of `result.ts` at the max-lines cap
 * (mechanical extraction only, same split idiom as `result-attempt-outcome.ts`):
 * the P14 send-frequency bucket write `resolveAck`'s second transaction
 * issues after its job-outcome/money writes. See `result.ts`'s own module
 * header for the full ack-path write order this fits into.
 */

export interface WriteSendFrequencyBucketInput {
  clientId: string;
  /** `message_jobs.recipient_hash` (P14) - null for a `@g.us` recipient or a pre-P14 row; the write skips entirely when null. */
  recipientHash?: Buffer | null;
  /** `message_jobs.recipient_jid` (P14) - `@g.us` recipients are excluded from the write regardless of `recipientHash`. */
  recipientJid?: string | null;
}

/**
 * P14 Unit U4, step 6: send-frequency bucket - skipped for a group
 * recipient (`@g.us`) or a null hash (pre-P14 row / caller that never
 * threaded one). hour_bucket = date_trunc('hour', <send time>) - the
 * migration 0036 contract, computed in-statement, never in Node.
 */
export async function writeSendFrequencyBucket(
  tx: TenantQueryable,
  input: WriteSendFrequencyBucketInput,
): Promise<void> {
  const isGroup = input.recipientJid?.endsWith('@g.us') ?? true;
  if (!input.recipientHash || isGroup) {
    return;
  }

  await tx.query(
    `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
     VALUES ($1, $2, date_trunc('hour', now()), 1)
     ON CONFLICT (client_id, phone_hash, hour_bucket)
     DO UPDATE SET count = recipient_send_buckets.count + 1
     -- client_id = $1`,
    [input.clientId, input.recipientHash],
  );
}

export interface StampCampaignRecipientSentInput {
  clientId: string;
  /** `message_jobs.id` (the JOB, never the `publicId` string `resolveAck` carries) - see this function's own doc for why. */
  jobId: string;
  /** A genuine first charge's own rate (`charge.seq !== null`) - null for a replayed debit, which leaves `charged_minor` untouched (see caller, `resolveAck`). */
  chargedMinor: number | null;
}

/**
 * P23a Unit U1b, step 3 (fix round: keyed off `jobId`, not `publicId`) - the
 * send-result half of `campaign_recipients` funnel stamping: `queued ->
 * sent`. `resolveAck`'s `input.publicId` is NOT the `message_job_refs.
 * public_id` uuid for a real claimed job: `send-loop.ts#jobToDispatchInput`
 * sets `publicId: job.id` (the numeric `message_jobs.id`, used only as an
 * opaque string inside `deliveryEventId(...)`) because `claim-jobs.sql`'s
 * RETURNING list carries no `public_id` column at all - only a test helper
 * that hand-seeds a `message_job_refs` row and passes ITS uuid as `publicId`
 * (`seedDispatchedAttempt`) ever gave this function a real uuid. So this
 * joins back to `message_job_refs` itself by `(client_id, message_job_id)` -
 * `expand-campaign-batch.sql`'s `ref` CTE inserts exactly one ref row per
 * job (never zero, never more), so the join resolves to exactly one
 * `public_id` per job, no unique index on `message_job_id` alone required.
 * The WHERE guard's `status = 'queued'` makes a replay match ZERO rows (no
 * dead tuple); a receipt for a non-campaign job's id simply matches no row
 * either (no ref, or a ref whose public_id no campaign_recipients row
 * carries). Never writes `campaign_counters` (see `receipts-campaign-
 * stamp.ts`'s own module doc for why that write does not belong here).
 *
 * The WHERE guard's `status IN ('queued', 'cancelled')` (P23a fix round,
 * unit F2): a recipient cancel-bookkeeping already stamped 'cancelled' whose
 * send nevertheless completes (claimed before the cancel commit - the
 * in-flight-across-cancel race) is truthfully 'sent' - the message reached a
 * person and `debit-send.sql` charged it exactly once, so the funnel row
 * must mirror the job row instead of diverging from it. `recomputeCampaignFunnel`
 * reconciles `campaign_counters` from this same row afterwards. A replay
 * still matches ZERO rows once `status = 'sent'` (not in the allow-list);
 * `pending`/`skipped`/`failed`/`sent`/`delivered`/`read` rows are never
 * touched, and cancel-bookkeeping's own guard (`pending`/`queued` only)
 * never reverts a 'sent' row back to 'cancelled' either.
 */
export async function stampCampaignRecipientSent(
  tx: TenantQueryable,
  input: StampCampaignRecipientSentInput,
): Promise<void> {
  await tx.query(
    `UPDATE campaign_recipients r SET status = 'sent', sent_at = COALESCE(r.sent_at, now()),
            charged_minor = COALESCE($3, r.charged_minor)
      FROM message_job_refs ref
      WHERE ref.client_id = $1 AND ref.message_job_id = $2
        AND r.client_id = $1 AND r.message_job_public_id = ref.public_id
        AND r.status IN ('queued', 'cancelled')
      -- client_id = $1`,
    [input.clientId, input.jobId, input.chargedMinor],
  );
}
