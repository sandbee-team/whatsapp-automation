import { loadQuery, bindQueryParams, type TenantDb } from '@wp/db';
import type { DashboardSummaryData } from '@wp/contracts';
import { tenantKey } from '../../platform/redis.js';

/**
 * summary.service.ts (P17 carried item) - `readDashboardSummary`: the
 * dashboard's `{connectedNumbers, queued, sent}` triple, one client-scoped
 * statement (`db/queries/dashboard-summary.sql`). `connectedNumbers` =
 * count of that client's instances with `health_state = 'connected'`;
 * `queued` = a BOUNDED (`LIMIT 10001`) count of that client's queued jobs
 * (same bounded-probe idiom `instance-card-queue-depth.sql` uses); `sent` =
 * today's sent count read from the SAME stored `client_daily_usage` counter
 * the reserve path maintains - never a `count(*)` over `message_jobs`.
 * Client-scoped throughout - never cross-tenant.
 */

const CACHE_TTL_SEC = 5;

export interface DashboardServiceRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
}

export interface ReadDashboardSummaryInput {
  clientId: string;
}

interface DashboardSummaryRow extends Record<string, unknown> {
  connected_numbers: string;
  queued: string;
  sent: number | null;
}

async function computeSummary(
  tenantDb: TenantDb,
  input: ReadDashboardSummaryInput,
): Promise<DashboardSummaryData> {
  const query = await loadQuery('dashboard-summary');
  const params = bindQueryParams(query, { client_id: input.clientId });
  const result = await tenantDb.withTenant(input.clientId, (tx) =>
    tx.query<DashboardSummaryRow>(query.text, params),
  );
  const row = result.rows[0];
  return {
    connectedNumbers: Number(row?.connected_numbers ?? 0),
    queued: Number(row?.queued ?? 0),
    sent: row?.sent ?? 0,
  };
}

/**
 * Reads the dashboard summary, cached in Redis for 5s per client
 * (rebuildable: a cache miss OR a Redis error recomputes directly - never
 * fails the summary). Injecting `redis` is OPTIONAL - a caller without a
 * Redis handle simply always recomputes.
 */
export async function readDashboardSummary(
  tenantDb: TenantDb,
  input: ReadDashboardSummaryInput,
  cache?: { redis: DashboardServiceRedis; env: string },
): Promise<DashboardSummaryData> {
  if (!cache) {
    return computeSummary(tenantDb, input);
  }

  const key = tenantKey(cache.env, input.clientId, 'dashboard-summary');
  try {
    const cached = await cache.redis.get(key);
    if (cached) {
      return JSON.parse(cached) as DashboardSummaryData;
    }
  } catch {
    // Redis down/unreachable - fall through to a direct compute below.
  }

  const summary = await computeSummary(tenantDb, input);

  try {
    await cache.redis.set(key, JSON.stringify(summary), 'EX', CACHE_TTL_SEC);
  } catch {
    // Cache write failure is never fatal.
  }

  return summary;
}
