import { logger } from '@wp/server-kit';
import { loadNamedQuery, bindQueryParams, type TenantDb } from '@wp/db';
import { recomputeCampaignFunnel } from './funnel.repo.js';

/**
 * funnel.sweep.ts (P23a Unit U2) - the cross-tenant progress-funnel
 * recompute sweep, cron-driven at two cadences (`cron-wiring-broadcasts.ts`):
 * `mode: 'active'` (every 5s - the live funnel's own refresh floor, one
 * index-only aggregate per active campaign) and `mode: 'hourly'` (every
 * hour - crash reconciliation for rows the active loop no longer visits,
 * e.g. a terminal campaign whose `campaign_counters.recomputed_at` was
 * never set because a crash landed between `createCampaign` and the first
 * active-loop tick).
 *
 * Discovery is deliberately cross-tenant (`db/queries/
 * broadcast-funnel-pending.sql`'s two named sections, bounded by `LIMIT`);
 * every per-campaign recompute then runs its OWN `tenantDb.withTenant`
 * transaction (via `recomputeCampaignFunnel`), wrapped in its own try/catch
 * so one tenant's failure never aborts the rest of this sweep's clients -
 * same shape as `runOneCancelBookkeepingSweep`.
 *
 * P23a C1 fix round unit F2 - `funnel-active`'s discovery is a KEYSET
 * ROTATION by primary key (`id > $cursor ORDER BY id LIMIT $limit`, served
 * by the partial index `campaigns_funnel_discovery_idx`), never `ORDER BY
 * updated_at` (see the .sql file's own header for why that starves a
 * cross-tenant campaign past position LIMIT). `activeCursor` is an
 * in-process rotation cursor the cron loop shares across ticks
 * (`createFunnelActiveCursor()` below is the module-level default instance
 * `cron-wiring-broadcasts.ts` wires in); `funnel-hourly` has no cursor - its
 * `updated_at`-ordered belt-and-braces scan is unaffected by this fix.
 */

export interface FunnelRecomputeSweepPool {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Rotation cursor for the `mode: 'active'` discovery scan - `get()` reads the last-seen id, `set()` advances it. Kept as an injectable interface (never a bare module variable) so tests can seed/inspect it deterministically. */
export interface FunnelActiveCursor {
  get(): string;
  set(value: string): void;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Builds a fresh in-memory `FunnelActiveCursor` starting at the zero uuid - `cron-wiring-broadcasts.ts` builds ONE instance and shares it across every active-loop tick for the process's lifetime. With N cron replicas each holds its OWN cursor and wins an arbitrary subset of ticks (the single-flight lock is per tick, not sticky leadership): every replica's cursor still advances monotonically over the ticks it wins and wraps on a short tick, so coverage stays complete and starvation-free - a full pass just takes ~N× the ticks. */
export function createFunnelActiveCursor(): FunnelActiveCursor {
  let value = ZERO_UUID;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

export interface RunOneFunnelRecomputeSweepDeps {
  pool: FunnelRecomputeSweepPool;
  tenantDb: TenantDb;
  mode: 'active' | 'hourly';
  maxCampaignsPerSweep?: number;
  /** Optional (P23a C1 fix round unit F2) - the `mode: 'active'` rotation cursor. Omitted defaults to a fresh, per-call cursor (starts at the zero uuid every tick) so every existing caller keeps compiling; the cron wiring always supplies the shared instance. */
  activeCursor?: FunnelActiveCursor;
  /** Injectable for tests - defaults to `@wp/server-kit`'s `logger`. */
  logger?: { warn: (meta: Record<string, unknown>, message: string) => void };
}

const DEFAULT_ACTIVE_LIMIT = 200;
const DEFAULT_HOURLY_LIMIT = 500;

/**
 * Loads this sweep's discovery query - the section name is a STRING LITERAL
 * at each call site below (never a variable built from `deps.mode`),
 * matching the literal-argument-pair idiom every other
 * `SCHEDULER_LOOP_MODULES` caller uses (`modules/wallet/reconcile.ts` is the
 * precedent) - `scripts/check-scheduler-queries.ts`'s guard can only see a
 * query name it can extract as a literal from the source text.
 */
async function loadDiscoveryQuery(mode: 'active' | 'hourly') {
  return mode === 'active'
    ? loadNamedQuery('broadcast-funnel-pending', 'funnel-active')
    : loadNamedQuery('broadcast-funnel-pending', 'funnel-hourly');
}

/** Runs ONE cross-tenant funnel-recompute sweep pass for the given `mode` - never aborts on a single campaign's failure. */
export async function runOneFunnelRecomputeSweep(
  deps: RunOneFunnelRecomputeSweepDeps,
): Promise<void> {
  const defaultLimit = deps.mode === 'active' ? DEFAULT_ACTIVE_LIMIT : DEFAULT_HOURLY_LIMIT;
  const limit = deps.maxCampaignsPerSweep ?? defaultLimit;
  const cursor = deps.mode === 'active' ? (deps.activeCursor ?? createFunnelActiveCursor()) : null;

  const query = await loadDiscoveryQuery(deps.mode);
  const params = cursor === null ? { limit } : { limit, cursor: cursor.get() };
  const pending = await deps.pool.query<{ id: string; client_id: string }>(
    query.text,
    bindQueryParams(query, params),
  );

  const log = deps.logger ?? logger;
  for (const row of pending.rows) {
    try {
      await recomputeCampaignFunnel(deps.tenantDb, {
        clientId: row.client_id,
        campaignId: row.id,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      // campaign_id is not in @wp/server-kit's LogFields allow-list (same
      // constraint cancel-bookkeeping.ts's own logger.warn call works
      // around) - the id goes in the free-text message, never a structured
      // field.
      log.warn(
        { client_id: row.client_id },
        `funnel-sweep: recompute failed for campaign ${row.id} (never aborts the rest of the sweep): ${name}`,
      );
    }
  }

  // Advance the rotation cursor to the last id this tick returned; wrap to
  // the zero uuid once a tick returns fewer than `limit` rows (a full pass
  // completed - the next tick restarts from the top). One bounded query per
  // tick, never a second lookahead query to detect "was that the last page".
  if (cursor !== null) {
    const lastRow = pending.rows[pending.rows.length - 1];
    if (lastRow !== undefined) {
      cursor.set(lastRow.id);
    }
    if (pending.rows.length < limit) {
      cursor.set(ZERO_UUID);
    }
  }
}
