import type { AdminReadQueryable } from '../../platform/platform-read.js';
import { decodeCursor, encodeCursor, type KeysetPage } from '../../platform/keyset.js';

/**
 * modules/instances/instances.read.ts (P28 Unit U4, step 7) - the
 * cross-tenant instance list and the per-client instance panel used by the
 * client-detail view. Registered platform reads only (see
 * `platform/platform-read.ts` and `platform/registered-reads.ts`).
 *
 * PROJECTION DISCIPLINE: NO `phone_e164`, `owner_jid` or `label`. Staff
 * diagnose a stuck instance from its STATES (health/link/desired), its
 * pause reason, its pacing band/tier, which worker owns its lease and how
 * fresh that lease is, plus queue depth and oldest-queued age - none of
 * which requires knowing the WhatsApp number behind it. The number is the
 * tenant's own business identity and their customers' contact surface;
 * exposing it on a routine ops list would make every staff session a
 * standing PII disclosure, which is exactly what the time-boxed
 * impersonation grant exists to avoid.
 */

export interface InstanceListItem {
  id: string;
  clientId: string;
  healthState: string;
  linkState: string | null;
  desiredState: string;
  pauseReason: string | null;
  band: string | null;
  tier: number | null;
  ownerWorkerId: string | null;
  leaseSeenAt: string | null;
  queueDepth: number;
  oldestQueuedAgeSeconds: number | null;
  createdAt: string;
}

/**
 * `queue_depth`/`oldest_queued_age_seconds` are computed with a correlated
 * subquery per instance against the CURRENT `message_jobs` partition set,
 * restricted to `status = 'queued'` - the same "queued jobs waiting on this
 * instance" definition `db/queries/fleet-gauges.sql` and the tenant
 * dashboard use, so a staff member and a tenant never see two different
 * numbers for the same fact.
 */
const INSTANCE_COLUMNS = `i.id,
         i.client_id,
         i.health_state::text AS health_state,
         i.link_state::text AS link_state,
         i.desired_state,
         i.pause_reason::text AS pause_reason,
         i.created_at,
         ps.health_band AS band,
         ps.warmup_tier AS tier,
         ls.owner_worker_id,
         ls.lease_seen_at,
         (SELECT count(*)::int FROM message_jobs j
           WHERE j.client_id = i.client_id AND j.instance_id = i.id
             AND j.status = 'queued') AS queue_depth,
         (SELECT floor(extract(epoch FROM (now() - min(j.created_at))))::int FROM message_jobs j
           WHERE j.client_id = i.client_id AND j.instance_id = i.id
             AND j.status = 'queued') AS oldest_queued_age_seconds`;

const INSTANCE_JOINS = `FROM whatsapp_instances i
    LEFT JOIN instance_pacing_state ps ON ps.instance_id = i.id AND ps.client_id = i.client_id
    LEFT JOIN instance_lease_state ls ON ls.instance_id = i.id AND ls.client_id = i.client_id`;

const LIST_INSTANCES_SQL = `SELECT ${INSTANCE_COLUMNS}
    ${INSTANCE_JOINS}
   WHERE i.deleted_at IS NULL
     AND ($1::text IS NULL OR i.health_state::text = $1)
     AND ($2::uuid IS NULL OR i.client_id = $2)
     AND ($3::timestamptz IS NULL OR (i.created_at, i.id) < ($3, $4::uuid))
   ORDER BY i.created_at DESC, i.id DESC
   LIMIT $5`;

const LIST_CLIENT_INSTANCES_SQL = `SELECT ${INSTANCE_COLUMNS}
    ${INSTANCE_JOINS}
   WHERE i.deleted_at IS NULL AND i.client_id = $1
   ORDER BY i.created_at DESC, i.id DESC
   LIMIT $2`;

interface RawInstanceRow extends Record<string, unknown> {
  id: string;
  client_id: string;
  health_state: string;
  link_state: string | null;
  desired_state: string;
  pause_reason: string | null;
  created_at: Date;
  band: string | null;
  tier: number | null;
  owner_worker_id: string | null;
  lease_seen_at: Date | null;
  queue_depth: number;
  oldest_queued_age_seconds: number | null;
}

function mapInstanceRow(row: RawInstanceRow): InstanceListItem {
  return {
    id: row.id,
    clientId: row.client_id,
    healthState: row.health_state,
    linkState: row.link_state,
    desiredState: row.desired_state,
    pauseReason: row.pause_reason,
    band: row.band,
    tier: row.tier,
    ownerWorkerId: row.owner_worker_id,
    leaseSeenAt: row.lease_seen_at ? row.lease_seen_at.toISOString() : null,
    queueDepth: row.queue_depth,
    oldestQueuedAgeSeconds: row.oldest_queued_age_seconds,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ListInstancesFilter {
  healthState?: string;
  clientId?: string;
  limit: number;
  cursor?: string;
}

/** Keyset-paginated cross-tenant instance list, optionally narrowed by health state and/or one client. */
export async function listInstances(
  db: AdminReadQueryable,
  filter: ListInstancesFilter,
): Promise<KeysetPage<InstanceListItem>> {
  const cursor = decodeCursor(filter.cursor);
  const result = await db.query<RawInstanceRow>(LIST_INSTANCES_SQL, [
    filter.healthState ?? null,
    filter.clientId ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    filter.limit,
  ]);
  const last = result.rows[result.rows.length - 1];
  return {
    items: result.rows.map(mapInstanceRow),
    nextCursor:
      result.rows.length === filter.limit && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
        : null,
  };
}

/**
 * The client-detail view's instance panel: every live instance of ONE
 * client, hard-capped by `limit` (a workspace's instance count is bounded
 * by its plan, so this is a bounded read by construction - no cursor
 * needed, but the cap is explicit rather than implied).
 */
export async function listClientInstances(
  db: AdminReadQueryable,
  clientId: string,
  limit: number,
): Promise<InstanceListItem[]> {
  const result = await db.query<RawInstanceRow>(LIST_CLIENT_INSTANCES_SQL, [clientId, limit]);
  return result.rows.map(mapInstanceRow);
}
