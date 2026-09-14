import { loadNamedQuery, bindQueryParams, type TenantDb } from '@wp/db';
import { notify, buildNotificationDedupeKey } from '../notifications/index.js';

/**
 * modules/inbound/optout-rate-check.ts (P25 observability-and-runbook, Unit
 * U3) - the one genuinely per-client check the blueprint names ("opt-out
 * rate > 10/1,000 for a client - a content problem we should tell them
 * about"), implemented as a Postgres check that `notify()`s the tenant -
 * NEVER as a Prometheus series (a `client_id` label is forbidden by the
 * four-gauge rule in `@wp/server-kit`'s `metric-policy.ts`).
 *
 * Threshold: opt-outs * 1000 > 10 * acked sends over the trailing 24h,
 * evaluated only for clients with >= 100 acked sends in the window (a tiny
 * sample is noise) - see `db/queries/metric-rollups.sql`'s
 * `optout-rate-flagged-clients` section for the exact predicate. EVERY
 * client with an opt-out in the window is evaluated; the SQL LIMIT bounds
 * only the FLAGGED (rate-exceeding) candidate set, ordered by rate
 * descending. This module then excludes candidates already notified today
 * (a single batched lookup by dedupe_key - the storage-layer unique
 * constraint remains the sole dedupe AUTHORITY, this is a pre-filter so a
 * client whose slot was consumed by an earlier run's notification never
 * blocks a lower-rate client from being notified in a LATER run) and takes
 * the top `deps.maxClientsPerRun` (default `OPTOUT_RATE_MAX_CLIENTS_PER_RUN`)
 * of what remains. Runs on an HOURLY cadence (`cron-wiring-rollups.ts`),
 * deduped one notification per client per UTC day (`bucket` = today's UTC
 * date, `transitionId` = the client id - same 'instance-day' dedupe-scope
 * shape as `wallet_low`, see `state-notifier.ts`'s own header for the
 * mapping). Payload = counts only (`acked_sends`, `optouts`, `per_thousand`)
 * - never a phone number or message body.
 *
 * A per-client `notify` failure is caught and logged (name only, never a pg
 * message/detail) and never aborts the rest of the run - same "a single
 * tenant's failure never blocks the fleet-wide sweep" shape as every other
 * cross-tenant cron loop in this tree (e.g. `cron-wiring-epoch.ts`'s own
 * per-instance try/catch).
 */

export const OPTOUT_RATE_THRESHOLD_PER_THOUSAND = 10;
export const OPTOUT_RATE_MIN_SENDS = 100;
export const OPTOUT_RATE_MAX_CLIENTS_PER_RUN = 100;

interface OptoutRateFlaggedRow extends Record<string, unknown> {
  client_id: string;
  acked_sends: number;
  optouts: number;
}

/**
 * Safety multiplier applied to the SQL LIMIT beyond `maxClientsPerRun`, so
 * candidates already notified today (excluded below) don't consume the
 * business limit's slots and starve a lower-rate client in a later run - see
 * this module's own header. Bounded absolutely (never unbounded) - ADR 0018
 * S4's per-tick cost is still O(clients-with-optouts), just a wider slice of
 * that set is fetched than will ultimately be notified.
 */
const CANDIDATE_FETCH_MULTIPLIER = 5;

export interface OptoutRateCheckPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface RunOptoutRateCheckDeps {
  pool: OptoutRateCheckPool;
  tenantDb: TenantDb;
  /** Epoch ms "now" - injected, never `Date.now()` read inside this module (fake-clock discipline). */
  nowMs: number;
  logger?: { error: (fields: Record<string, unknown>, message: string) => void };
  /** Overrides `OPTOUT_RATE_MAX_CLIENTS_PER_RUN` - test-only knob for the LIMIT on the flagged set. */
  maxClientsPerRun?: number;
}

export interface RunOptoutRateCheckResult {
  flagged: number;
  notified: number;
}

function utcDateBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function tickFailureMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  const suffix = code ? ` (${String(code)})` : '';
  return `optout rate check: notify failed for one client, continuing: ${name}${suffix}`;
}

/** Runs the flagged-clients query, then `notify()`s each flagged client (`optout_rate_high`, deduped once per UTC day). */
export async function runOptoutRateCheck(
  deps: RunOptoutRateCheckDeps,
): Promise<RunOptoutRateCheckResult> {
  const maxClientsPerRun = deps.maxClientsPerRun ?? OPTOUT_RATE_MAX_CLIENTS_PER_RUN;
  const query = await loadNamedQuery('metric-rollups', 'optout-rate-flagged-clients');
  const result = await deps.pool.query<OptoutRateFlaggedRow>(
    query.text,
    bindQueryParams(query, {
      limit: maxClientsPerRun * CANDIDATE_FETCH_MULTIPLIER,
      min_sends: OPTOUT_RATE_MIN_SENDS,
      per_thousand: OPTOUT_RATE_THRESHOLD_PER_THOUSAND,
    }),
  );

  const bucket = utcDateBucket(deps.nowMs);
  const dedupeKeyByClientId = new Map(
    result.rows.map((row) => [
      row.client_id,
      buildNotificationDedupeKey({ kind: 'optout_rate_high', transitionId: row.client_id, bucket }),
    ]),
  );
  const alreadyNotified = await alreadyNotifiedClientIds(deps.pool, dedupeKeyByClientId);
  const rowsToNotify = result.rows
    .filter((row) => !alreadyNotified.has(row.client_id))
    .slice(0, maxClientsPerRun);

  let notified = 0;

  for (const row of rowsToNotify) {
    const perThousand = Math.floor((row.optouts * 1000) / row.acked_sends);
    try {
      const outcome = await deps.tenantDb.withTenant(row.client_id, (tx) =>
        notify(tx, {
          clientId: row.client_id,
          kind: 'optout_rate_high',
          transitionId: row.client_id,
          bucket,
          payload: {
            acked_sends: row.acked_sends,
            optouts: row.optouts,
            per_thousand: perThousand,
          },
        }),
      );
      if (outcome.created) {
        notified += 1;
      }
    } catch (err) {
      deps.logger?.error({}, tickFailureMessage(err));
    }
  }

  return { flagged: result.rows.length, notified };
}

/**
 * One batched lookup of which of `dedupeKeyByClientId`'s candidates already
 * have a `notifications` row for today's bucket - a pre-filter only (see
 * this module's own header); `notify()`'s `notifications_dedupe_uq`
 * constraint remains the sole dedupe AUTHORITY.
 */
async function alreadyNotifiedClientIds(
  pool: OptoutRateCheckPool,
  dedupeKeyByClientId: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  if (dedupeKeyByClientId.size === 0) {
    return new Set();
  }
  const clientIds = [...dedupeKeyByClientId.keys()];
  const dedupeKeys = clientIds.map((clientId) => dedupeKeyByClientId.get(clientId));
  const existing = await pool.query<{ client_id: string }>(
    `SELECT client_id FROM notifications
      WHERE client_id = ANY($1) AND dedupe_key = ANY($2) AND kind = 'optout_rate_high'`,
    [clientIds, dedupeKeys],
  );
  return new Set(existing.rows.map((row) => row.client_id));
}
