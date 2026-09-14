import type { TenantQueryable } from '@wp/db';

/**
 * receipts-campaign-stamp.ts (P23a Unit U1b, step 3) - the receipt-path half
 * of `campaign_recipients` funnel stamping: a `delivered`/`read` receipt
 * advances the matching recipient row `sent -> delivered -> read`,
 * MONOTONICALLY, via `message_job_refs` (keyed by ids, never a bound
 * `created_at` `Date` - see `recordInboundReceipt`'s own module doc for the
 * microsecond-precision hazard this avoids) joined to
 * `campaign_recipients.message_job_public_id`. The send-result half
 * (`queued -> sent`) lives in `engine/queue/result-ack-side-effects.ts`
 * (`stampCampaignRecipientSent`) - this module never writes `status='sent'`.
 *
 * Never writes `campaign_counters` (the funnel recompute counts
 * `GROUP BY status` separately - a counter write here would be a second,
 * redundant writer and a dead-tuple generator on the hot receipt path).
 */

export interface StampCampaignRecipientReceiptInput {
  clientId: string;
  messageJobId: string;
  /** The `::text` literal of `message_jobs.created_at` (never a JS `Date` - see module doc). */
  messageJobCreatedAtText: string;
  eventType: 'delivered' | 'read' | 'sent' | 'retry_scheduled' | 'failed';
}

/**
 * ONE idempotent UPDATE, keyed by ids: `message_job_refs` resolves
 * `(client_id, message_job_id, message_job_created_at)` to its `public_id`,
 * which joins `campaign_recipients.message_job_public_id`. Only
 * `'delivered'`/`'read'` advance anything - any other `eventType` (including
 * `'sent'`, which the OTHER stamp function owns) returns 0 rows changed
 * without issuing a write. A replay that would change nothing matches ZERO
 * rows (the WHERE guard below), so no dead tuple is produced. Returns the
 * number of rows changed - callers ignore it for the receipt's own outcome
 * (a receipt for a non-campaign job simply matches no row, which is not an
 * error).
 */
export async function stampCampaignRecipientReceipt(
  tx: TenantQueryable,
  input: StampCampaignRecipientReceiptInput,
): Promise<number> {
  if (input.eventType !== 'delivered' && input.eventType !== 'read') {
    return 0;
  }

  const isRead = input.eventType === 'read';
  const result = await tx.query(
    `UPDATE campaign_recipients r SET
        delivered_at = CASE WHEN $4 THEN r.delivered_at ELSE COALESCE(r.delivered_at, now()) END,
        read_at = CASE WHEN $4 THEN COALESCE(r.read_at, now()) ELSE r.read_at END,
        status = CASE
                   WHEN $4 THEN 'read'
                   WHEN r.status = 'sent' THEN 'delivered'
                   ELSE r.status
                 END
       FROM message_job_refs ref
      WHERE ref.client_id = $1
        AND ref.message_job_id = $2
        AND ref.message_job_created_at = $3::timestamptz
        AND r.client_id = $1
        AND r.message_job_public_id = ref.public_id
        AND (
          ($4 AND r.read_at IS NULL)
          OR (NOT $4 AND r.status IN ('sent', 'read') AND r.delivered_at IS NULL)
        )
      -- client_id = $1`,
    [input.clientId, input.messageJobId, input.messageJobCreatedAtText, isRead],
  );

  return result.rowCount ?? 0;
}
