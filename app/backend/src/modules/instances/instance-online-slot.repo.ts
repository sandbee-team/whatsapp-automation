import { loadQuery, bindQueryParams } from '@wp/db';
import type { InstanceCtx } from './repo.js';
import { setDesiredState } from './repo.js';
import { listOnlineHolders, readPlanLimits } from './instance-reads.repo.js';
import type { OnlineHolder } from './instance-reads.repo.js';

/**
 * instance-online-slot.repo.ts (P08 E3 FIX 3) - makes the connected-slot cap
 * check ATOMIC at the storage layer (core invariant 3: the cap is an
 * entitlement limit, not a best-effort check). `instances.routes.ts`'s
 * online handler used to run "count online, then write desired_state" as
 * two separate statements with no conditional-update guard tying them
 * together - two concurrent requests could both observe
 * onlineCount < maxConnected and both land online, exceeding the cap.
 *
 * `setOnlineWithSlotCheck` runs ONE transaction that:
 *   1. Serialises per-CLIENT via the `instance-online-slot-lock-client`
 *      statement (client_id-scoped `FOR UPDATE` on the caller's own row,
 *      see that .sql file's own header) - the client row as a cheap slot
 *      mutex, uncontended except during genuinely racing online calls for
 *      the SAME client. `wp_app` holds SELECT+UPDATE on that table
 *      (migration 0005; live-verified 2026-08-31), so `FOR UPDATE` is
 *      privilege-legal for this role - no `pg_advisory_xact_lock` fallback
 *      needed.
 *   2. Counts online instances (same transaction, same lock held).
 *   3. Either returns the current holders (cap reached - caller maps this
 *      to 409 NO_FREE_SLOT) or performs the `setDesiredState('online')`
 *      write - all inside the same transaction, so no second racer can
 *      slip in between the count and the write.
 *
 * Every statement here is client_id-scoped (check-tenant-scope). The plain
 * `setDesiredState('offline')` park path is UNCHANGED - parking never needs
 * a slot.
 *
 * FIX BATCH B / B1 (slot-count off-by-one): the count used to include the
 * target instance itself, so re-onlining an ALREADY-online instance under a
 * full cap counted itself as an occupant of the very slot it was asking
 * for, and got a 409 NO_FREE_SLOT naming itself as the blocker. Fixed two
 * ways, both needed: (i) a short-circuit - if the target row's own
 * `desired_state` is already 'online', return `{ ok: true }` before
 * counting at all (no-op, idempotent); (ii) for the remaining (not-already-
 * online) path, the slot count now EXCLUDES the target row
 * (`instance-count-online-others.sql`, `id <> $instance_id`) - the plain
 * `instance-count-online.sql` (no exclusion) is untouched and still used by
 * `instance-reads.repo.ts`'s own read paths.
 */

interface DesiredStateRow extends Record<string, unknown> {
  id: string;
  desired_state: string;
}

/** Reads the target instance's own current `desired_state` - `null` covers "not found"/"already deleted". */
async function readDesiredState(ctx: InstanceCtx, instanceId: string): Promise<string | null> {
  const query = await loadQuery('instance-read-desired-state');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<DesiredStateRow>(query.text, params);
  const row = result.rows[0];
  return row ? row.desired_state : null;
}

/** Counts this client's online instances EXCLUDING the target instance itself - the slot-check-specific count (see FIX BATCH B / B1 above). */
async function countOnlineInstancesExcluding(
  ctx: InstanceCtx,
  instanceId: string,
): Promise<number> {
  const query = await loadQuery('instance-count-online-others');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<{ count: number } & Record<string, unknown>>(
    query.text,
    params,
  );
  return result.rows[0]?.count ?? 0;
}

export interface OnlineSlotPool {
  connect(): Promise<OnlineSlotDbClient>;
}

export interface OnlineSlotDbClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  release(err?: unknown): void;
}

export type SetOnlineWithSlotCheckResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'no_free_slot'; holders: OnlineHolder[] }
  | { ok: false; reason: 'not_found' };

async function lockClientRow(client: OnlineSlotDbClient, clientId: string): Promise<void> {
  const query = await loadQuery('instance-online-slot-lock-client');
  const params = bindQueryParams(query, { client_id: clientId });
  await client.query(query.text, params);
}

/**
 * Runs the atomic check-and-set. `pool` is any real pool with `.connect()`
 * (the same `EntitlementDbPool`-shaped port `instances.routes-support.ts`
 * already hands the routes) - a fresh connection/transaction is opened here
 * specifically because `FOR UPDATE` must hold its lock for the count+write
 * that follows, which a bare pool `.query()` call (autocommit, no shared
 * connection) cannot provide.
 */
export async function setOnlineWithSlotCheck(
  pool: OnlineSlotPool,
  input: { clientId: string; instanceId: string },
): Promise<SetOnlineWithSlotCheckResult> {
  const client = await pool.connect();
  let releaseError: unknown;
  try {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config($1, $2, true)`, ['app.client_id', input.clientId]);
      const ctx: InstanceCtx = { clientId: input.clientId, sql: client };

      await lockClientRow(client, input.clientId);

      const currentDesiredState = await readDesiredState(ctx, input.instanceId);
      if (currentDesiredState === null) {
        await client.query('COMMIT');
        return { ok: false, reason: 'not_found' };
      }
      if (currentDesiredState === 'online') {
        // Short-circuit (FIX BATCH B / B1): already online is a no-op
        // success - never counted against its own slot. FIX ROUND 2 FIX 2:
        // `changed: false` tells the caller this was a no-op, so it never
        // appends a duplicate 'instance.online' audit row for a repeated
        // re-online call.
        await client.query('COMMIT');
        return { ok: true, changed: false };
      }

      const planLimits = await readPlanLimits(ctx);
      const onlineCount = await countOnlineInstancesExcluding(ctx, input.instanceId);
      const maxConnected = planLimits?.maxConnectedInstances ?? 0;

      if (onlineCount >= maxConnected) {
        const holders = await listOnlineHolders(ctx);
        await client.query('COMMIT');
        return { ok: false, reason: 'no_free_slot', holders };
      }

      const wrote = await setDesiredState(ctx, input.instanceId, 'online');
      if (!wrote) {
        await client.query('COMMIT');
        return { ok: false, reason: 'not_found' };
      }

      await client.query('COMMIT');
      return { ok: true, changed: true };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
        releaseError = undefined;
      } catch (rollbackErr) {
        releaseError = rollbackErr;
      }
      throw err;
    }
  } finally {
    if (releaseError !== undefined) {
      client.release(releaseError as Error);
    } else {
      client.release();
    }
  }
}
