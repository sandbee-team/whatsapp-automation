import { createHash, randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import {
  DEFAULT_BAND_WEIGHTS,
  renderVars,
  type Band,
  type JobPriority,
  type SendOrigin,
} from '@wp/domain';
import type { CampaignRow } from './snapshot.repo.js';

/**
 * expansion.repo.ts (P23 Unit U4, step 5) - Phase B's DB-access layer: the
 * per-client single-expander advisory lock, the keyset batch read, the
 * ref-first CTE call (`expand-campaign-batch.sql`), and the once-per-batch
 * cursor/counter UPDATEs.
 */

/**
 * `message_jobs.priority_rank` mapping - the SAME `@wp/domain`
 * `DEFAULT_BAND_WEIGHTS` DWRR weight table `messages.repo.ts#priorityRankFor`
 * derives from, duplicated here (never imported from `modules/messages`
 * directly or via its barrel - both reach `messages.routes.ts`'s own
 * transitive closure, which the cron-loop-shape structural test forbids
 * `modules/broadcasts` from pulling in through `cron-wiring-broadcasts.ts`).
 * `DEFAULT_BAND_WEIGHTS` itself remains the one numeric-weight authority;
 * this is a second CALLER of it, never a second table.
 */
const PRIORITY_TO_BAND: Readonly<Record<JobPriority, Band>> = Object.freeze({
  high: 'HIGH',
  normal: 'NORMAL',
  low: 'LOW',
});

/** Exported so `priority-rank-parity.test.ts` can assert this copy stays byte-identical to `modules/messages/messages.repo.ts`'s own `priorityRankFor` (see this module's doc comment above for why the mapping is duplicated rather than imported). */
export function priorityRankFor(priority: JobPriority): number {
  return DEFAULT_BAND_WEIGHTS[PRIORITY_TO_BAND[priority]];
}

export interface RecipientBatchRow extends Record<string, unknown> {
  id: string;
  recipient_jid: string;
  recipient_e164: string | null;
  recipient_hash: Buffer;
  vars: Record<string, string>;
}

/** Non-blocking per-client expander lock - `false` means another expander is already running for this client right now (`{ kind: 'held', reason: 'expander_busy' }`). Must be taken FIRST inside the batch transaction. */
export async function tryAcquireExpanderLock(
  tx: TenantQueryable,
  clientId: string,
): Promise<boolean> {
  const result = await tx.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(hashtext('wp:broadcast-expand:' || $1::text)) AS locked`,
    [clientId],
  );
  return result.rows[0]?.locked === true;
}

/** Reads `campaigns` scoped by client - reused from the snapshot repo's row shape (same columns needed: status, message, priority-adjacent fields read separately by the caller). `snapshot_done_at` is read additively (P23 Unit U6b) so the expansion sweep can compute `wp_broadcast_expansion_lag_seconds` without a second query. */
export async function readCampaignForExpansion(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<
  | (CampaignRow & {
      instance_id: string;
      priority: 'high' | 'normal' | 'low';
      scheduled_at: Date | null;
      expand_cursor_recipient_id: string;
      snapshot_done_at: Date | null;
    })
  | undefined
> {
  const result = await tx.query<
    CampaignRow & {
      instance_id: string;
      priority: 'high' | 'normal' | 'low';
      scheduled_at: Date | null;
      expand_cursor_recipient_id: string;
      snapshot_done_at: Date | null;
    }
  >(
    `SELECT id, client_id, status, audience, message, snapshot_cursor_contact_id,
            instance_id, priority, scheduled_at, expand_cursor_recipient_id, snapshot_done_at
       FROM campaigns
      WHERE id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  return result.rows[0];
}

export interface InstanceEpochRow extends Record<string, unknown> {
  session_epoch: number;
}

/** Reads the campaign's own instance's CURRENT session_epoch, at expansion time - never cached across batches. */
export async function readInstanceEpoch(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number | undefined> {
  const result = await tx.query<InstanceEpochRow>(
    `SELECT session_epoch FROM whatsapp_instances
      WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
      -- client_id = $2`,
    [instanceId, clientId],
  );
  return result.rows[0]?.session_epoch;
}

/** Bounded queue-depth probe for the campaign's own instance - the backpressure gate's input. */
export async function readInstanceQueueDepth(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  limitPlusOne: number,
): Promise<number> {
  const query = await loadQuery('expansion-instance-queue-depth');
  const result = await tx.query<{ queue_depth: string }>(
    query.text,
    bindQueryParams(query, {
      client_id: clientId,
      instance_id: instanceId,
      limit_plus_one: limitPlusOne,
    }),
  );
  return Number(result.rows[0]?.queue_depth ?? 0);
}

/** Reads the next batch of `pending` recipients strictly after the cursor, ordered by id. Empty result means exhaustion. */
export async function readExpansionBatch(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  cursor: string,
  batchSize: number,
): Promise<RecipientBatchRow[]> {
  const result = await tx.query<RecipientBatchRow>(
    `SELECT id, recipient_jid, recipient_e164, recipient_hash, vars
       FROM campaign_recipients
      WHERE campaign_id = $1 AND client_id = $2 AND id > $3 AND status = 'pending'
      -- client_id = $2
      ORDER BY id
      LIMIT $4`,
    [campaignId, clientId, cursor, batchSize],
  );
  return result.rows;
}

/** Marks rows that failed to render (a missing template token at expansion time - never expected once snapshot-time freezing is correct, but rendered defensively) terminally `failed`, set-based, in the same transaction. */
export async function markRenderFailed(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  recipientIds: string[],
): Promise<void> {
  if (recipientIds.length === 0) return;
  await tx.query(
    `UPDATE campaign_recipients SET status = 'failed', failure_class = 'render_failed', terminal_at = now()
      WHERE campaign_id = $1 AND client_id = $2 AND id = ANY($3::bigint[])
      -- client_id = $2`,
    [campaignId, clientId, recipientIds],
  );
}

export interface ExpandBatchInput {
  clientId: string;
  instanceId: string;
  campaignId: string;
  sessionEpoch: number;
  priority: 'high' | 'normal' | 'low';
  scheduledAt: Date | null;
  payloadKind: string;
}

export interface ExpandBatchStatementResult {
  /** Rows the `ref` CTE actually inserted this call - fewer than `rows.length` on a replay (dedupe conflict). Drives the queue's own send-side accounting, never the recipient counters. */
  inserted: number;
  /** Rows the `upd` CTE actually stamped `campaign_recipients.status = 'queued'` this call - a fresh expansion AND a genuine replay both count here (a replay resolves the recipient's already-committed `public_id` and stamps it, even though `ref` inserted 0 new rows for it). This is the ONLY count `bumpExpansionCounters` may use for the pending/queued deltas - never `inserted`. */
  stamped: number;
}

/** Runs the ref-first `expand-campaign-batch.sql` set-based statement for the renderable rows. */
export async function runExpandBatchStatement(
  tx: TenantQueryable,
  input: ExpandBatchInput,
  rows: Array<{
    recipientId: string;
    recipientJid: string;
    recipientE164: string | null;
    recipientHash: Buffer;
    body: string;
  }>,
): Promise<ExpandBatchStatementResult> {
  if (rows.length === 0) return { inserted: 0, stamped: 0 };

  const query = await loadQuery('expand-campaign-batch');
  const publicIds = rows.map(() => randomUUID());
  const dedupeKeys = rows.map((r) =>
    createHash('sha256').update(`${input.campaignId}:${r.recipientJid}`).digest('hex'),
  );
  const payloads = rows.map((r) => JSON.stringify({ text: r.body }));
  const priorityRank = priorityRankFor(input.priority);
  const scheduledAt = input.scheduledAt ?? new Date();
  const sendOrigin: SendOrigin = 'campaign';

  const result = await tx.query<{ inserted: string; stamped: string }>(
    query.text,
    bindQueryParams(query, {
      client_id: input.clientId,
      instance_id: input.instanceId,
      session_epoch: input.sessionEpoch,
      campaign_id: input.campaignId,
      payload_kind: input.payloadKind,
      priority: input.priority,
      priority_rank: priorityRank,
      scheduled_at: scheduledAt,
      recipient_ids: rows.map((r) => r.recipientId),
      public_ids: publicIds,
      recipient_jids: rows.map((r) => r.recipientJid),
      recipient_e164s: rows.map((r) => r.recipientE164),
      recipient_hashes: rows.map((r) => r.recipientHash),
      payloads,
      dedupe_keys: dedupeKeys,
    }),
  );
  void sendOrigin; // 'campaign' is baked into expand-campaign-batch.sql itself, never a parameter
  return {
    inserted: Number(result.rows[0]?.inserted ?? 0),
    stamped: Number(result.rows[0]?.stamped ?? 0),
  };
}

/** Renders every recipient's frozen vars against the campaign's message body - never re-reads the template or the contact at send time (already frozen at snapshot time). */
export function renderRecipient(
  body: string,
  vars: Record<string, string>,
): { ok: true; text: string } | { ok: false } {
  const rendered = renderVars(body, vars);
  return rendered.ok ? { ok: true, text: rendered.text } : { ok: false };
}

/** Advances `expand_cursor_recipient_id` monotonically - once per batch. */
export async function advanceExpansionCursor(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  maxRecipientId: string,
): Promise<void> {
  await tx.query(
    `UPDATE campaigns SET expand_cursor_recipient_id = $3, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND expand_cursor_recipient_id < $3
      -- client_id = $2`,
    [campaignId, clientId, maxRecipientId],
  );
}

/** Bumps `campaign_counters` aggregate deltas - once per batch. `stamped` is the `expand-campaign-batch.sql` `upd` CTE's own row count (recipients ACTUALLY moved `pending` -> `queued` this call, a fresh expansion or a genuine replay alike) - the only count that may drive the pending/queued deltas. `renderFailed` alone drives `failed`. Never derive either delta from the `ref` insert's row count: on a replay that under-counts every recipient the dedupe guard already owned before this call. */
export async function bumpExpansionCounters(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  deltas: { stamped: number; renderFailed: number },
): Promise<void> {
  await tx.query(
    `UPDATE campaign_counters SET pending = pending - $3, queued = queued + $4, failed = failed + $5, updated_at = now()
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [
      campaignId,
      clientId,
      deltas.stamped + deltas.renderFailed,
      deltas.stamped,
      deltas.renderFailed,
    ],
  );
}

/** Terminal write: cursor exhausted - conditional on `status = 'expanding'`. */
export async function completeExpansion(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  nextStatus: string,
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE campaigns SET expand_done_at = now(), status = $3, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'expanding'
      -- client_id = $2`,
    [campaignId, clientId, nextStatus],
  );
  return (result.rowCount ?? 0) > 0;
}
