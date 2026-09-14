import type { AdminReadQueryable } from '../../platform/platform-read.js';

/**
 * modules/queue/queue.read.ts (P28 Unit U4, step 7) - the fleet queue
 * summary: job counts by `message_jobs.status`, instance counts by health
 * state, and the unowned-instance count. COUNTS ONLY - this read projects
 * no per-row data at all, so it is the narrowest possible cross-tenant read
 * (the same "aggregate only, safe by construction" shape as
 * `db/queries/fleet-gauges.sql`, whose unowned predicate is reused verbatim
 * below so a staff member and the `wp_instances_unowned` gauge can never
 * disagree about what "unowned" means).
 *
 * `message_jobs` is partitioned by `created_at`; this counts the live
 * partition set as the planner sees it, deliberately NOT a time-bounded
 * window - the number staff act on is "how much work is queued right now",
 * and a queued job's age is exactly what makes it interesting.
 */

export interface QueueSummary {
  /** `status` -> job count, only for statuses that currently have rows. */
  jobsByStatus: Record<string, number>;
  /** `health_state` -> live instance count. */
  instancesByHealthState: Record<string, number>;
  /**
   * Instances the fleet is supposed to be carrying (`desired_state =
   * 'online'`, not deleted) that no worker currently holds a fresh lease
   * for - the same 45-second staleness window as `fleet-gauges.sql`.
   */
  unownedInstances: number;
}

function toCountMap(
  rows: Array<Record<string, unknown>>,
  keyColumn: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[String(row[keyColumn])] = Number(row.count);
  }
  return out;
}

/** The whole-fleet queue/health summary - counts only, no per-row projection (see module header). */
export async function readQueueSummary(db: AdminReadQueryable): Promise<QueueSummary> {
  // These statements live INSIDE the exported function, not at module
  // scope, so `scripts/check-tenant-scope.ts` attributes them to
  // `...queue.read.ts:readQueueSummary` - the key the CROSS_TENANT_QUERIES
  // registry actually names. A module-scope constant is attributed to
  // "(module scope)", which no registry entry can match.
  const JOBS_BY_STATUS_SQL = `SELECT status::text AS status, count(*)::int AS count
      FROM message_jobs
     GROUP BY status`;

  const INSTANCES_BY_HEALTH_SQL = `SELECT health_state::text AS health_state, count(*)::int AS count
      FROM whatsapp_instances
     WHERE deleted_at IS NULL
     GROUP BY health_state`;

  // Predicate copied from db/queries/fleet-gauges.sql's unowned_count (same
  // LEFT JOIN shape, same 45s window) - see module header.
  const UNOWNED_INSTANCES_SQL = `SELECT count(*)::int AS count
      FROM whatsapp_instances i
      LEFT JOIN instance_lease_state ls
        ON ls.instance_id = i.id AND ls.client_id = i.client_id
     WHERE i.desired_state = 'online'
       AND i.deleted_at IS NULL
       AND (ls.instance_id IS NULL
            OR ls.lease_seen_at IS NULL
            OR ls.lease_seen_at < now() - interval '45 seconds')`;

  const jobs = await db.query(JOBS_BY_STATUS_SQL);
  const instances = await db.query(INSTANCES_BY_HEALTH_SQL);
  const unowned = await db.query<{ count: number }>(UNOWNED_INSTANCES_SQL);
  return {
    jobsByStatus: toCountMap(jobs.rows, 'status'),
    instancesByHealthState: toCountMap(instances.rows, 'health_state'),
    unownedInstances: Number(unowned.rows[0]?.count ?? 0),
  };
}
