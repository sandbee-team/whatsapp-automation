import type { TenantDb, TenantQueryable } from '@wp/db';
import { nextCampaignState } from '@wp/domain';
import { emit } from '../events/index.js';
import { transition, type CountersRow } from './broadcasts.repo.js';

/**
 * funnel.repo.ts (P23a Unit U2) - reconciles `campaign_counters` to
 * `campaign_recipients` ROW TRUTH (a full recount, never a per-send
 * increment on the hot counter row - that is a dead-tuple generator and is
 * NOT done anywhere in this codebase), writes `completed` (the ONLY place
 * that ever does, and only from `running`), and emits `campaign.progress` at
 * most once per recompute batch, only when something actually changed.
 *
 * `campaign_recipients.status` is a PARTITION of the audience
 * (`pending|skipped|queued|sent|delivered|read|failed|cancelled`, `total =
 * Σ buckets`) - `deferred` is a DERIVED display bucket computed at read
 * time from a live pacing-deny check (`broadcasts.repo.ts#
 * countDeferredRecipients`), never stored here or anywhere else.
 *
 * Receipt-derived `delivered`/`read` counts are a LOWER BOUND: a delivery
 * receipt arriving before the corresponding `message_wa_ids` row resolves
 * the wa-id back to this recipient is lost to this recount (the row simply
 * stays `sent`) - this reconcile can only count what `campaign_recipients.
 * status` already reflects, it does not itself resolve receipts.
 */

interface RecountRow extends Record<string, unknown> {
  total: string;
  pending: string;
  skipped: string;
  queued: string;
  sent: string;
  delivered: string;
  read: string;
  failed: string;
  cancelled: string;
  charged_minor: string;
}

/** ONE aggregate over `campaign_recipients` - the row truth `reconcileCounters` reconciles `campaign_counters` to. Client-scoped. */
export async function recountRecipients(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<RecountRow> {
  const result = await tx.query<RecountRow>(
    `SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE status = 'pending')::text AS pending,
        count(*) FILTER (WHERE status = 'skipped')::text AS skipped,
        count(*) FILTER (WHERE status = 'queued')::text AS queued,
        count(*) FILTER (WHERE status = 'sent')::text AS sent,
        count(*) FILTER (WHERE status = 'delivered')::text AS delivered,
        count(*) FILTER (WHERE status = 'read')::text AS read,
        count(*) FILTER (WHERE status = 'failed')::text AS failed,
        count(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
        COALESCE(SUM(charged_minor), 0)::text AS charged_minor
       FROM campaign_recipients
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('recountRecipients: aggregate query returned no row');
  }
  return row;
}

export interface ReconcileResult {
  changed: boolean;
  counters: CountersRow;
}

/**
 * Reconciles `campaign_counters` to a fresh `recountRecipients` truth in ONE
 * statement: `IS DISTINCT FROM` gates the UPDATE so a quiet tick (nothing
 * changed since the last reconcile) touches ZERO rows - no dead tuple. When
 * the counters row is missing (never happens on the `createCampaign` path,
 * which always inserts one, but a reconcile must never crash on its
 * absence) it is inserted first from the same truth.
 */
export async function reconcileCounters(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<ReconcileResult> {
  const truth = await recountRecipients(tx, clientId, campaignId);

  const result = await tx.query<CountersRow & { changed: boolean }>(
    `WITH upsert AS (
       INSERT INTO campaign_counters
         (campaign_id, client_id, total, pending, skipped, queued, sent, delivered,
          read, failed, cancelled, charged_minor, recomputed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
       ON CONFLICT (campaign_id) DO UPDATE SET
         total = EXCLUDED.total,
         pending = EXCLUDED.pending,
         skipped = EXCLUDED.skipped,
         queued = EXCLUDED.queued,
         sent = EXCLUDED.sent,
         delivered = EXCLUDED.delivered,
         read = EXCLUDED.read,
         failed = EXCLUDED.failed,
         cancelled = EXCLUDED.cancelled,
         charged_minor = EXCLUDED.charged_minor,
         recomputed_at = now(),
         updated_at = now()
       WHERE campaign_counters.client_id = EXCLUDED.client_id
         AND ROW(campaign_counters.total, campaign_counters.pending, campaign_counters.skipped,
                 campaign_counters.queued, campaign_counters.sent, campaign_counters.delivered,
                 campaign_counters.read, campaign_counters.failed, campaign_counters.cancelled,
                 campaign_counters.charged_minor)
             IS DISTINCT FROM
             (EXCLUDED.total, EXCLUDED.pending, EXCLUDED.skipped, EXCLUDED.queued,
              EXCLUDED.sent, EXCLUDED.delivered, EXCLUDED.read, EXCLUDED.failed,
              EXCLUDED.cancelled, EXCLUDED.charged_minor)
       RETURNING total, pending, skipped, queued, sent, delivered, read, failed,
                 cancelled, charged_minor, true AS changed
     )
     SELECT * FROM upsert
     -- client_id = $2`,
    [
      campaignId,
      clientId,
      truth.total,
      truth.pending,
      truth.skipped,
      truth.queued,
      truth.sent,
      truth.delivered,
      truth.read,
      truth.failed,
      truth.cancelled,
      truth.charged_minor,
    ],
  );

  const row = result.rows[0];
  if (row) {
    const counters: CountersRow = {
      total: row.total,
      pending: row.pending,
      skipped: row.skipped,
      queued: row.queued,
      sent: row.sent,
      delivered: row.delivered,
      read: row.read,
      failed: row.failed,
      cancelled: row.cancelled,
      charged_minor: row.charged_minor,
    };
    return { changed: true, counters };
  }

  // Nothing changed (or the row already matched the truth on insert
  // conflict with no distinct values) - read the current row back for the
  // return value, never assume the truth values without a read.
  const current = await tx.query<CountersRow>(
    `SELECT total, pending, skipped, queued, sent, delivered, read, failed, cancelled, charged_minor
       FROM campaign_counters
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  const currentRow = current.rows[0];
  if (!currentRow) {
    throw new Error('reconcileCounters: campaign_counters row missing after upsert');
  }
  return { changed: false, counters: currentRow };
}

interface CampaignDrainRow extends Record<string, unknown> {
  status: string;
  expand_done_at: Date | null;
}

/**
 * Writes `completed` - the ONLY place that ever does, and ONLY from
 * `running`, via `nextCampaignState('running', 'complete')` +
 * `broadcasts.repo.ts#transition` (the one conditional UPDATE). Requires
 * `expand_done_at IS NOT NULL` (Phase B has finished) and no recipient
 * remaining `pending`/`queued` (nothing left to send or still in flight). A
 * `paused`/`cancelled`/`failed` campaign is never completed by this path.
 */
export async function completeIfDrained(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<boolean> {
  const campaignResult = await tx.query<CampaignDrainRow>(
    `SELECT status, expand_done_at FROM campaigns WHERE id = $1 AND client_id = $2 -- client_id = $2`,
    [campaignId, clientId],
  );
  const campaign = campaignResult.rows[0];
  if (!campaign || campaign.status !== 'running' || campaign.expand_done_at === null) {
    return false;
  }

  const pendingResult = await tx.query<{ found: number }>(
    `SELECT 1 AS found FROM campaign_recipients
      WHERE campaign_id = $1 AND client_id = $2 AND status IN ('pending', 'queued')
      -- client_id = $2
      LIMIT 1`,
    [campaignId, clientId],
  );
  if (pendingResult.rows.length > 0) {
    return false;
  }

  const result = await transition(tx, {
    clientId,
    id: campaignId,
    from: 'running',
    to: nextCampaignState('running', 'complete'),
  });
  return result !== undefined;
}

/** Pure derivation of the `campaign.progress` payload - ids/enums-shaped counts only, exactly `REALTIME_PAYLOAD_KEYS['campaign.progress']` (`campaignId, sent, queued, failed`). `sent` sums the whole "sent family" (sent + delivered + read); `queued` sums the whole "not yet terminal" family (pending + queued). */
export function progressPayloadFor(
  campaignId: string,
  counters: CountersRow,
): { campaignId: string; sent: number; queued: number; failed: number } {
  return {
    campaignId,
    sent: Number(counters.sent) + Number(counters.delivered) + Number(counters.read),
    queued: Number(counters.pending) + Number(counters.queued),
    failed: Number(counters.failed),
  };
}

/** Emits `campaign.progress` for this recompute - `entityId` derives the SSE coalesce key automatically (see `emit.ts`'s own header). */
export async function emitProgress(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  counters: CountersRow,
): Promise<void> {
  await emit(tx, {
    clientId,
    type: 'campaign.progress',
    entityId: campaignId,
    payload: progressPayloadFor(campaignId, counters),
    fanout: ['sse'],
  });
}

export interface RecomputeCampaignFunnelInput {
  clientId: string;
  campaignId: string;
}

export interface RecomputeCampaignFunnelResult {
  changed: boolean;
  completed: boolean;
}

/**
 * ONE `withTenant` transaction: `reconcileCounters` -> `completeIfDrained`
 * -> `emitProgress` iff `changed || completed`. This is "at most one
 * `campaign.progress` per recompute batch per campaign" - never more than
 * one `emit` call regardless of how many things changed in this pass.
 */
export async function recomputeCampaignFunnel(
  tenantDb: TenantDb,
  input: RecomputeCampaignFunnelInput,
): Promise<RecomputeCampaignFunnelResult> {
  return tenantDb.withTenant(input.clientId, async (tx) => {
    const { changed, counters } = await reconcileCounters(tx, input.clientId, input.campaignId);
    const completed = await completeIfDrained(tx, input.clientId, input.campaignId);

    if (changed || completed) {
      await emitProgress(tx, input.clientId, input.campaignId, counters);
    }

    return { changed, completed };
  });
}
