import type { createPool } from '@wp/db';
import type { ScaleFleet } from './scale-fleet.js';
import type { ScaleFleetPlan } from '../../../../../scripts/measure/scale-fleet.js';
import type { SendLoadPlanItem } from './send-load-driver.js';
import { readPendingJobCount, readPendingJobSample } from './run-pg-load-snapshots.js';

/**
 * run-pg-load-fleet.ts (P26 U4 fix - real workers) - max-lines split off
 * `run-pg-load.ts` (established idiom, `session-worker-discovery-wiring.ts`):
 * the `ScaleFleetPlan` builder, the post-`fleet.start()` send-plan reader
 * (real assigned instances only - `fleet.ownerMap()` joined against
 * `whatsapp_instances` for `client_id`, never a second, unassigned
 * `seedScaleFleet` call), and the drain poller.
 *
 * WHY `fleet.ownerMap()` AND NOT A SECOND SEED: `scale-fleet.ts#start()`
 * already seeds tenants/instances AND assigns each one to a spawned child
 * (`spreadInstances` + an `assign` IPC round-trip) - only THOSE instances
 * are ever claimed by a real worker. `seedScaleFleet` performs plain
 * `INSERT`s with fresh `randomUUID()`s on every call (`scale-fleet-seed.ts`),
 * so a second, independent call would mint a disjoint set of rows nothing
 * has been assigned to - `runSendLoad` would enqueue jobs no child ever
 * claims, reproducing exactly the bug this fix exists to remove. This
 * module's `buildSendPlanFromFleet` instead reads back the REAL seeded+
 * assigned instance ids via `fleet.ownerMap()` (populated once `start()`
 * resolves) and looks up each one's `client_id` from `whatsapp_instances`.
 *
 * WHY `raiseSeededPacingCaps` EXISTS: `createScaleFleet#start()` calls
 * `seedScaleFleet(handles, plan)` with NO options, so every fleet-assigned
 * instance gets the seed defaults `eff_hourly_cap 60` / `eff_daily_cap 600`
 * and there is no override channel through `createScaleFleet` today. A
 * measurement needing more than 60 sends per instance would therefore stall
 * on the hourly cap until the next clock hour. This helper raises the caps
 * on exactly the fleet's OWN assigned instances (`= ANY($ids)`, never a
 * name prefix, never a table-wide UPDATE), after `start()` and before the
 * BEFORE snapshot. It only ever RAISES a measurement's headroom on rows
 * this run itself seeded; it is not a tenant setting, and `run-pg-load.ts`
 * records both values in the artifact's `notes`.
 */

export function buildScaleFleetPlan(input: {
  instances: number;
  workers: number;
  tenants: number;
}): ScaleFleetPlan {
  const workers = Math.max(1, input.workers);
  const instancesPerWorker = Math.max(1, Math.ceil(input.instances / workers));
  return {
    workers,
    instancesPerWorker,
    tenants: Math.max(1, input.tenants),
    sessionCap: instancesPerWorker + 1,
  };
}

/**
 * Reads the fleet's own owner map (populated by `fleet.start()`'s real
 * `assign` round-trip) and resolves each instance's `client_id` from
 * `whatsapp_instances` - the ONLY source of the send plan (never a second
 * seed, see module doc). `intervalMs` is fixed per instance so
 * `runSendLoad`'s jittered schedule spreads sends rather than firing every
 * instance in lockstep.
 */
export async function buildSendPlanFromFleet(
  pool: ReturnType<typeof createPool>,
  fleet: ScaleFleet,
  intervalMs: number,
): Promise<{ plan: SendLoadPlanItem[]; clientIds: string[]; instanceIds: string[] }> {
  const owners = await fleet.ownerMap();
  const instanceIds = Array.from(owners.keys());
  if (instanceIds.length === 0) {
    return { plan: [], clientIds: [], instanceIds: [] };
  }
  // Tenant-scoped (invariant 4): only the fleet's OWN seeded tenants.
  const result = await pool.query<{ id: string; client_id: string }>(
    'SELECT id, client_id FROM whatsapp_instances WHERE id = ANY($1) AND client_id = ANY($2)',
    [instanceIds, fleet.clientIds()],
  );
  const clientIds: string[] = [];
  const plan: SendLoadPlanItem[] = [];
  for (const row of result.rows) {
    clientIds.push(row.client_id);
    plan.push({
      clientId: row.client_id,
      instanceId: row.id,
      intervalMs,
      tenantKey: row.client_id,
    });
  }
  return { plan, clientIds, instanceIds };
}

/**
 * Raises `eff_hourly_cap`/`eff_daily_cap` on the fleet's own assigned
 * instances so the run's `sends/instances` can actually drain (see module
 * header). Both values are validated against the DB CHECK ceilings by
 * `assertDrainFeasible` BEFORE the fleet is ever started, so a violation is
 * an operator error reported up front rather than a mid-run constraint
 * failure. Returns the number of rows actually updated - the caller treats
 * a short count as a hard error, never a warning.
 */
export async function raiseSeededPacingCaps(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
  caps: { hourlyCap: number; dailyCap: number },
): Promise<number> {
  if (instanceIds.length === 0) return 0;
  const result = await pool.query(
    `UPDATE instance_pacing_state SET eff_hourly_cap = $3, eff_daily_cap = $4,
            eff_new_conv_cap = $4, updated_at = now()
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds, caps.hourlyCap, caps.dailyCap],
  );
  return result.rowCount ?? 0;
}

/**
 * FIX-P26-E: thrown by `waitForDrain` on timeout. Carries a scoped, read-only
 * sample of at most 20 pending jobs (`readPendingJobSample`, tenant-scoped)
 * so a caller can write a partial `.INCOMPLETE.json` artifact naming WHICH
 * jobs stalled, instead of writing nothing (the Harness gap this fix closes -
 * run log row 26, plan/v1/P26-scale-proof-1k.md).
 */
export class DrainTimeoutError extends Error {
  override readonly name = 'DrainTimeoutError';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  readonly pending: number;
  readonly pendingSample: { id: string; status: string; attempts: number }[];

  constructor(input: {
    elapsedMs: number;
    timeoutMs: number;
    pending: number;
    pendingSample: { id: string; status: string; attempts: number }[];
  }) {
    super(
      `waitForDrain: timed out after ${(input.elapsedMs / 1000).toFixed(1)}s (${String(input.elapsedMs)}ms, limit ${String(input.timeoutMs)}ms) with ${String(input.pending)} jobs still pending`,
    );
    this.elapsedMs = input.elapsedMs;
    this.timeoutMs = input.timeoutMs;
    this.pending = input.pending;
    this.pendingSample = input.pendingSample;
  }
}

/** Polls `readPendingJobCount` every `intervalMs` until it hits zero or `timeoutMs` elapses (never a fixed sleep - queue drain time is not a constant). Throws `DrainTimeoutError` LOUDLY (pending count + sample + elapsed time) on timeout - never swallowed. */
export async function waitForDrain(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const startedAtMs = Date.now();
  const deadline = startedAtMs + timeoutMs;
  for (;;) {
    const pending = await readPendingJobCount(pool, clientIds);
    if (pending === 0) return;
    if (Date.now() >= deadline) {
      const elapsedMs = Date.now() - startedAtMs;
      const pendingSample = await readPendingJobSample(pool, clientIds);
      throw new DrainTimeoutError({ elapsedMs, timeoutMs, pending, pendingSample });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
