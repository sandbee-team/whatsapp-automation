import type { TenantQueryable } from '@wp/db';
import type { BroadcastStatus } from '@wp/domain';

/**
 * broadcasts.repo.ts (P23 Unit U5, step 6) - SQL-only DB access for the
 * broadcast lifecycle: create (campaign row + its zero `campaign_counters`
 * row in one transaction), the idempotency replay no-op, keyset read/list,
 * and the ONE conditional-UPDATE `transition()` every mutation (start/pause/
 * resume/cancel) goes through - a zero-row UPDATE means someone else already
 * moved the campaign first (core invariant 3: idempotency/consistency at the
 * storage layer, never a blind retry).
 */

export interface CreateCampaignInput {
  clientId: string;
  instanceId: string;
  createdByUserId: string;
  idempotencyKey: string;
  name: string;
  audience: Record<string, unknown>;
  message: Record<string, unknown>;
  priority: 'high' | 'normal' | 'low';
  scheduledAt: string | null;
  /** `campaigns.target_kind` - ALWAYS derived server-side from `audience.kind` by the caller (`lifecycle.service.ts#createBroadcast`), never a client-supplied field (P24 groups-messaging Unit U6). */
  targetKind: 'contacts' | 'groups';
}

interface CreateCampaignRow extends Record<string, unknown> {
  id: string;
  created: boolean;
}

/**
 * Inserts the `campaigns` row (status `'draft'`) and its zero `campaign_
 * counters` row in the SAME transaction. The idempotency replay path uses
 * the no-op `DO UPDATE ... RETURNING` idiom `messages.repo.ts#enqueueMessageJob`
 * established (never a bare `ON CONFLICT DO NOTHING`, which would return no
 * row at all to the loser of a race and force a 5xx) - `xmax = 0` tells the
 * caller whether THIS call actually inserted the row.
 */
export async function createCampaign(
  tx: TenantQueryable,
  input: CreateCampaignInput,
): Promise<{ id: string; created: boolean }> {
  const result = await tx.query<CreateCampaignRow>(
    `WITH campaign AS (
       INSERT INTO campaigns
         (id, client_id, instance_id, created_by_user_id, idempotency_key, name,
          audience, message, target_kind, priority, scheduled_at, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft')
       ON CONFLICT (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET id = campaigns.id
       RETURNING id, (xmax = 0) AS created
     )
     SELECT id, created FROM campaign
     -- client_id = $1`,
    [
      input.clientId,
      input.instanceId,
      input.createdByUserId,
      input.idempotencyKey,
      input.name,
      JSON.stringify(input.audience),
      JSON.stringify(input.message),
      input.targetKind,
      input.priority,
      input.scheduledAt,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('createCampaign: insert/replay CTE returned no row');
  }

  if (row.created) {
    await tx.query(
      `INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)
       -- client_id = $2`,
      [row.id, input.clientId],
    );
  }

  return { id: row.id, created: row.created };
}

export interface CampaignSummaryRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: BroadcastStatus;
  instance_id: string;
  priority: 'high' | 'normal' | 'low';
  audience_count: number | null;
  quote_minor: string | null;
  price_key: string | null;
  scheduled_at: Date | null;
  snapshot_done_at: Date | null;
  expand_done_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const CAMPAIGN_SUMMARY_COLUMNS = `id, name, status, instance_id, priority, audience_count,
       quote_minor, price_key, scheduled_at, snapshot_done_at, expand_done_at,
       cancel_reason, created_at, updated_at`;

/** Reads one campaign row, scoped by client - a foreign/missing id returns `undefined` (404, never 403). */
export async function readCampaign(
  tx: TenantQueryable,
  clientId: string,
  id: string,
): Promise<CampaignSummaryRow | undefined> {
  const result = await tx.query<CampaignSummaryRow>(
    `SELECT ${CAMPAIGN_SUMMARY_COLUMNS} FROM campaigns
      WHERE id = $1 AND client_id = $2
      -- client_id = $2`,
    [id, clientId],
  );
  return result.rows[0];
}

export interface ListCampaignsInput {
  clientId: string;
  limit: number;
  cursor?: { createdAt: string; id: string };
}

/** Keyset list by `(created_at DESC, id DESC)` - NEVER `OFFSET`. */
export async function listCampaigns(
  tx: TenantQueryable,
  input: ListCampaignsInput,
): Promise<CampaignSummaryRow[]> {
  if (input.cursor) {
    const result = await tx.query<CampaignSummaryRow>(
      `SELECT ${CAMPAIGN_SUMMARY_COLUMNS} FROM campaigns
        WHERE client_id = $1 AND (created_at, id) < ($2, $3)
        -- client_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [input.clientId, input.cursor.createdAt, input.cursor.id, input.limit],
    );
    return result.rows;
  }
  const result = await tx.query<CampaignSummaryRow>(
    `SELECT ${CAMPAIGN_SUMMARY_COLUMNS} FROM campaigns
      WHERE client_id = $1
      -- client_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [input.clientId, input.limit],
  );
  return result.rows;
}

export interface TransitionInput {
  clientId: string;
  id: string;
  from: BroadcastStatus | BroadcastStatus[];
  to: BroadcastStatus;
  set?: Record<string, unknown>;
}

/**
 * The ONE conditional UPDATE every lifecycle mutation goes through:
 * `WHERE id = $ AND client_id = $ AND status = ANY($from)`. Zero rows means
 * someone else already moved it first (or it never existed for this
 * client) - the caller maps that to `IllegalBroadcastTransitionError`
 * (start/pause/resume) or treats it as not-found (cancel on a foreign
 * campaign), never a blind retry.
 */
export async function transition(
  tx: TenantQueryable,
  input: TransitionInput,
): Promise<CampaignSummaryRow | undefined> {
  const fromList = Array.isArray(input.from) ? input.from : [input.from];
  const extraSet = input.set ?? {};
  const extraKeys = Object.keys(extraSet);
  const setClauses = extraKeys.map((key, i) => `${key} = $${String(i + 5)}`);
  const setSql = setClauses.length > 0 ? `${setClauses.join(', ')}, ` : '';

  const result = await tx.query<CampaignSummaryRow>(
    `UPDATE campaigns SET ${setSql}status = $3, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status = ANY($4)
      -- client_id = $2
      RETURNING ${CAMPAIGN_SUMMARY_COLUMNS}`,
    [input.id, input.clientId, input.to, fromList, ...extraKeys.map((key) => extraSet[key])],
  );
  return result.rows[0];
}

export interface CountersRow extends Record<string, unknown> {
  total: number;
  pending: number;
  skipped: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  cancelled: number;
  charged_minor: string;
}

/** Reads the O(1) rollup row - scoped by client. */
export async function readCounters(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<CountersRow | undefined> {
  const result = await tx.query<CountersRow>(
    `SELECT total, pending, skipped, queued, sent, delivered, read, failed, cancelled, charged_minor
       FROM campaign_counters
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  return result.rows[0];
}

/** Derived, read-time count of this campaign's `queued` jobs currently pacing-deferred - NEVER stored (see `campaign_counters.ts`'s own header). */
export async function countDeferredRecipients(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<number> {
  const result = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_jobs
      WHERE client_id = $1 AND campaign_id = $2 AND status = 'queued' AND pacing_deny_reason IS NOT NULL
      -- client_id = $1`,
    [clientId, campaignId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Lists every non-deleted `whatsapp_instances` id/status for the client - `createBroadcast`'s instance-ownership check. */
export async function findInstanceForClient(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<{ id: string } | undefined> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM whatsapp_instances WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
      -- client_id = $2`,
    [instanceId, clientId],
  );
  return result.rows[0];
}
