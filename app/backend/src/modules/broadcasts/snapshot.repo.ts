import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { normaliseJid } from '@wp/domain';
import type { AudienceMatchParams, BroadcastAudienceJson } from './audience.js';
import type { SnapshotAudienceRow } from './snapshot-vars.js';

/**
 * snapshot.repo.ts (P23 Unit U4, step 4; widened P24 Unit U6, step 9) -
 * Phase A's DB-access layer: the ceiling count, one keyset batch read, the
 * set-based `campaign_recipients` INSERT (`ON CONFLICT ... DO NOTHING`,
 * counting only rows ACTUALLY inserted so a crash-replay never
 * double-counts), and the once-per-batch cursor/counter UPDATEs. All
 * queries scoped by `client_id` (core invariant 4).
 *
 * `snapshot_cursor_contact_id` is reused, unrenamed, as the groups audience's
 * own keyset cursor column too (a campaign is either `contacts` or `groups`,
 * never both - see `audience-groups.ts`'s own doc comment).
 */

export interface CampaignRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  status: string;
  audience: BroadcastAudienceJson;
  message: { kind: 'text'; body: string };
  snapshot_cursor_contact_id: string | null;
  /** Needed by a `groups` campaign's snapshot branch (`wa_groups` is instance-scoped) - always present, harmlessly unread by the contacts branch. */
  instance_id: string;
}

/** Reads the one campaign row a snapshot/expansion batch needs, scoped by client. */
export async function readCampaignForSnapshot(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<CampaignRow | undefined> {
  const result = await tx.query<CampaignRow>(
    `SELECT id, client_id, status, audience, message, snapshot_cursor_contact_id, instance_id
       FROM campaigns
      WHERE id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  return result.rows[0];
}

/** Counts the DISTINCT live contacts the audience JSON matches - the ceiling check's own input, run once before the first batch. */
export async function countAudience(
  tx: TenantQueryable,
  clientId: string,
  match: AudienceMatchParams,
): Promise<number> {
  const query = await loadQuery('snapshot-audience-count');
  const result = await tx.query<{ count: string }>(
    query.text,
    bindQueryParams(query, {
      client_id: clientId,
      contact_ids: match.contactIds,
      tag_ids: match.tagIds,
    }),
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface SnapshotBatchOptions {
  clientId: string;
  cursorContactId: string | null;
  match: AudienceMatchParams;
  batchSize: number;
}

/** Reads the next batch of audience contacts strictly after the cursor. Empty result means exhaustion. */
export async function readSnapshotBatch(
  tx: TenantQueryable,
  options: SnapshotBatchOptions,
): Promise<SnapshotAudienceRow[]> {
  const query = await loadQuery('snapshot-audience-batch');
  const result = await tx.query<SnapshotAudienceRow>(
    query.text,
    bindQueryParams(query, {
      client_id: options.clientId,
      cursor_contact_id: options.cursorContactId ?? '00000000-0000-0000-0000-000000000000',
      contact_ids: options.match.contactIds,
      tag_ids: options.match.tagIds,
      batch_size: options.batchSize,
    }),
  );
  return result.rows;
}

/** Exactly one of `contactId`/`groupId` is set (mirrors `cr_exactly_one_target`'s own CHECK) - `recipientE164` is `null` for a group row (`mj_recipient_shape`'s other branch). */
export interface RecipientInsertRow {
  contactId: string | null;
  groupId?: string | null;
  recipientJid: string;
  recipientE164: string | null;
  recipientHash: Buffer;
  status: 'pending' | 'skipped';
  skipReason: string | null;
  vars: Record<string, string>;
}

/** Derives `recipient_jid` from `wa_jid` via `@wp/domain#normaliseJid` - falls back to the raw `wa_jid` when the domain module cannot classify it (never blocks a snapshot batch on an unattributable JID; the recipient still exists, addressed by its stored `wa_jid`). */
export function recipientJidFor(waJid: string): string {
  const normalised = normaliseJid(waJid);
  return normalised.jid.length > 0 ? normalised.jid : waJid;
}

/**
 * Set-based INSERT of one batch's `campaign_recipients` rows via
 * `unnest(...)` arrays - one statement, never one per row.
 * `ON CONFLICT (campaign_id, coalesce(contact_id, group_id)) DO NOTHING
 * RETURNING id` counts only rows THIS call actually inserted (a crash-replay
 * re-running the same batch must never double-count against
 * `campaign_counters`).
 */
export async function insertRecipientBatch(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  rows: RecipientInsertRow[],
): Promise<{ insertedCount: number; pendingCount: number; skippedCount: number }> {
  if (rows.length === 0) {
    return { insertedCount: 0, pendingCount: 0, skippedCount: 0 };
  }

  const result = await tx.query<{ status: 'pending' | 'skipped' }>(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, contact_id, group_id, recipient_jid, recipient_e164, recipient_hash,
        status, skip_reason, vars)
     SELECT $1, $2, contact_id, group_id, recipient_jid, recipient_e164, recipient_hash,
            status::broadcast_recipient_status, skip_reason, vars
       FROM unnest(
         $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::bytea[], $8::text[], $9::text[], $10::jsonb[]
       ) AS t(contact_id, group_id, recipient_jid, recipient_e164, recipient_hash, status, skip_reason, vars)
     ON CONFLICT (campaign_id, coalesce(contact_id, group_id)) DO NOTHING
     RETURNING status
     -- client_id = $1`,
    [
      clientId,
      campaignId,
      rows.map((r) => r.contactId),
      rows.map((r) => r.groupId ?? null),
      rows.map((r) => r.recipientJid),
      rows.map((r) => r.recipientE164),
      rows.map((r) => r.recipientHash),
      rows.map((r) => r.status),
      rows.map((r) => r.skipReason),
      rows.map((r) => JSON.stringify(r.vars)),
    ],
  );

  let pendingCount = 0;
  let skippedCount = 0;
  for (const row of result.rows) {
    if (row.status === 'pending') pendingCount += 1;
    else skippedCount += 1;
  }
  return { insertedCount: result.rows.length, pendingCount, skippedCount };
}

/** Advances `snapshot_cursor_contact_id` monotonically - once per batch, never per row. */
export async function advanceSnapshotCursor(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  maxContactId: string,
): Promise<void> {
  await tx.query(
    `UPDATE campaigns SET snapshot_cursor_contact_id = $3
      WHERE id = $1 AND client_id = $2
        AND (snapshot_cursor_contact_id IS NULL OR snapshot_cursor_contact_id < $3)
      -- client_id = $2`,
    [campaignId, clientId, maxContactId],
  );
}

/** Bumps `campaign_counters` aggregate deltas - once per batch, never per row. */
export async function bumpSnapshotCounters(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  deltas: { total: number; pending: number; skipped: number },
): Promise<void> {
  await tx.query(
    `UPDATE campaign_counters SET total = total + $3, pending = pending + $4, skipped = skipped + $5, updated_at = now()
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId, deltas.total, deltas.pending, deltas.skipped],
  );
}

/** Terminal write: the campaign failed the ceiling check - conditional on `status = 'snapshotting'` so a concurrently cancelled/paused campaign is never overwritten. */
export async function failSnapshotForLimit(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  cancelReason: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE campaigns SET status = 'failed', cancel_reason = $3, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'snapshotting'
      -- client_id = $2`,
    [campaignId, clientId, cancelReason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Terminal write: the final (short/empty) batch - stamps `snapshot_done_at`, `audience_count`, and advances status to `expanding`. Conditional on `status = 'snapshotting'`. */
export async function completeSnapshot(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  nextStatus: string,
): Promise<{ done: boolean; audienceCount: number }> {
  const countResult = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM campaign_recipients
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  const audienceCount = Number(countResult.rows[0]?.count ?? 0);

  const update = await tx.query(
    `UPDATE campaigns SET snapshot_done_at = now(), audience_count = $3, status = $4, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'snapshotting'
      -- client_id = $2`,
    [campaignId, clientId, audienceCount, nextStatus],
  );
  return { done: (update.rowCount ?? 0) > 0, audienceCount };
}
