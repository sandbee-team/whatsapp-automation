import { createMetricsRegistry } from '@wp/server-kit';
import { createTenantDb, type createPool } from '@wp/db';
import { bindQueueMetrics } from '../queue/metrics.js';
import { runOneReaperSweep } from '../../modules/queue/reaper.js';
import { runOneReconcilerSweep } from '../../modules/queue/reconciler.js';
import { createCountingNoOpRepairedSendSink } from '../../modules/queue/repaired-send-sink.js';
import type { ChaosRunRecord, ChaosScenario } from '../../../../../scripts/chaos/run-chaos.js';
import type { ScaleFleet } from './scale-fleet.js';
import type { SyntheticFleetHandles } from '../session/synthetic-fleet-support.js';

/**
 * run-chaos-fleet-reads.ts (P26 U6c) - the shared scenario CONTEXT, the empty
 * `ChaosRunRecord` factory, the bounded outcome-poll, the row-count readers
 * and the reaper+reconciler sweep used by every scenario body in
 * `run-chaos-fleet-scenarios.ts`. Split off purely for that file's own
 * `max-lines: 300` cap (established idiom - `run-pg-load-fleet.ts`).
 *
 * Every reader here goes to Postgres ROWS or `fleet.ownerMap()` - never a
 * harness running total (invariant 7). Nothing in this module mutates fleet
 * state; the scenario bodies own all the destructive steps.
 */

export interface ScenarioContext {
  fleet: ScaleFleet;
  handles: SyntheticFleetHandles;
  pool: ReturnType<typeof createPool>;
  fleetShape: { instances: number; workers: number; sessionsPerWorker: number };
  workerIds: string[];
  /** The tenants this fleet seeded - every read below is `client_id`-scoped to them (invariant 4). */
  clientIds: string[];
  /** Bounded OUTCOME-poll deadline for every "is it re-owned yet" wait, ms. */
  outcomeDeadlineMs: number;
  /** Only ever `'redis-ctl'` reaches a real FLUSHALL - anything else must be refused before any I/O. */
  flushTarget: string;
}

/** Takeover SLO (design S4): every instance of a dead worker is re-owned within 45s. */
export const TAKEOVER_SLO_MS = 45_000;

export function baseRecord(scenario: ChaosScenario, ctx: ScenarioContext): ChaosRunRecord {
  return {
    schemaVersion: 1,
    kind: 'chaos',
    scenario,
    capturedAtIso: new Date().toISOString(),
    fleet: ctx.fleetShape,
    measurements: {},
    sloTargets: {},
    verdict: 'PASS',
    problems: [],
    notes: [],
  };
}

export async function waitForOutcome(
  predicate: () => Promise<boolean>,
  deadlineMs: number,
  pollMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Row-count-only status tally for every job owned by `instanceIds`. */
export async function jobStatusTally(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<{ total: number; byStatus: Map<string, number> }> {
  if (instanceIds.length === 0) return { total: 0, byStatus: new Map() };
  const rows = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM message_jobs
      WHERE instance_id = ANY($1) AND client_id = ANY($2) GROUP BY status`,
    [instanceIds, clientIds],
  );
  const byStatus = new Map<string, number>();
  let total = 0;
  for (const r of rows.rows) {
    const n = Number(r.count);
    byStatus.set(r.status, n);
    total += n;
  }
  return { total, byStatus };
}

/**
 * `send_attempts` ROW COUNT for the fleet's own instances - the liveness
 * cross-check every scenario reports as `sendsObserved`.
 *
 * WHY IT EXISTS (P26 run log): the fleet child used to never call
 * `sendLoopWiring.reconcile()`, the only path that starts a per-instance send
 * loop, so NO fleet-scale run ever claimed a job - every "zero jobs lost"
 * identity held VACUOUSLY (nothing was ever sent) and every artifact looked
 * healthy. A run where `sendsObserved` is 0 has proven nothing about the send
 * path, so it is recorded on every scenario rather than inferred.
 */
export async function countSendAttempts(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<number> {
  if (instanceIds.length === 0) return 0;
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM send_attempts
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return Number(r.rows[0]?.count ?? '0');
}

export async function readFence(
  pool: ReturnType<typeof createPool>,
  instanceId: string,
  clientIds: string[],
): Promise<bigint | undefined> {
  const r = await pool.query<{ current_fence: string }>(
    'SELECT current_fence FROM instance_lease_state WHERE instance_id = $1 AND client_id = ANY($2)',
    [instanceId, clientIds],
  );
  const row = r.rows[0];
  return row ? BigInt(row.current_fence) : undefined;
}

export async function readFences(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const id of instanceIds) {
    const fence = await readFence(pool, id, clientIds);
    if (fence !== undefined) out.set(id, fence);
  }
  return out;
}

/** Reaper sweep then reconciler sweep - the ONLY sanctioned way a `needs_reconcile` row becomes explained (resolved or `blocked_needs_review`), never a silent re-queue. */
export async function sweepUntilExplained(pool: ReturnType<typeof createPool>): Promise<void> {
  const metrics = bindQueueMetrics(createMetricsRegistry());
  const sink = createCountingNoOpRepairedSendSink();
  const tenantDb = createTenantDb(pool);
  await runOneReaperSweep({
    pool,
    tenantDb,
    metrics,
    sink,
    graceSeconds: 30,
    limit: 1000,
    rng: { random: () => 0 },
  });
  await runOneReconcilerSweep({
    pool,
    tenantDb,
    metrics,
    sink,
    reconcileWindowMs: 5 * 60_000,
    echoToleranceMs: 5 * 60_000,
    maxRows: 1000,
    now: () => Date.now() + 5 * 60_000 + 60_000,
  });
}

export async function readLinkStates(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<Map<string, string>> {
  if (instanceIds.length === 0) return new Map();
  const r = await pool.query<{ id: string; link_state: string }>(
    'SELECT id, link_state FROM whatsapp_instances WHERE id = ANY($1) AND client_id = ANY($2)',
    [instanceIds, clientIds],
  );
  return new Map(r.rows.map((row) => [row.id, row.link_state]));
}

export async function readCredVersions(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<Map<string, bigint>> {
  if (instanceIds.length === 0) return new Map();
  const r = await pool.query<{ instance_id: string; cred_version: string }>(
    `SELECT instance_id, cred_version FROM whatsapp_session_credentials
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return new Map(r.rows.map((row) => [row.instance_id, BigInt(row.cred_version)]));
}

/** How many of `instanceIds` are STILL recorded against one of `staleWorkerIds` - the observable "mid-roll, not yet reassigned" population for a graceful drain (see rolling-deploy-workload.ts's GROUND TRUTH note). */
export async function countStillOwnedBy(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  staleWorkerIds: string[],
  clientIds: string[],
): Promise<number> {
  if (instanceIds.length === 0 || staleWorkerIds.length === 0) return 0;
  const r = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM instance_lease_state
       WHERE instance_id = ANY($1) AND owner_worker_id = ANY($2) AND client_id = ANY($3)`,
    [instanceIds, staleWorkerIds, clientIds],
  );
  return Number(r.rows[0]?.count ?? '0');
}

/**
 * NOT RUN from this runnable, deliberately and honestly. U6a's outage drill
 * works by wrapping a real `pg.Pool` in a failing proxy
 * (`test/integration/chaos/postgres-outage-workload.ts`) - that module lives
 * under `test/`, which `app/backend/src/**` may not import, and the drill
 * needs to inject the proxy INTO the worker composition, which this runner's
 * children (real separate processes) never expose. Stopping the real
 * container is refused outright: this box also hosts a 7-day drift run and a
 * pacing smoke against the same Postgres. The integration test is the
 * evidence for this scenario.
 */
export function runPostgresOutageNotRun(ctx: ScenarioContext): ChaosRunRecord {
  const record = baseRecord('postgres-outage', ctx);
  record.measurements = { notRun: 1, sendsObserved: 0 };
  record.sloTargets = {
    notRun: 'n/a - see notes',
    sendsObserved: 'n/a - this scenario is not executed here (sendsObserved is 0 by construction)',
  };
  record.notes.push(
    'notRun: this scenario is NOT executed by run-chaos-fleet. Its drill needs the failing-pool ' +
      'proxy from test/integration/chaos/postgres-outage-workload.ts, which src/** may not import ' +
      'and which must be injected into the worker composition (this runner uses real child ' +
      'processes). Stopping the real Postgres container is refused: a 7-day drift run and a ' +
      'pacing smoke share it. Evidence for this scenario is ' +
      'postgres-outage.integration.test.ts, which passes against a real outage proxy.',
  );
  return record;
}

/**
 * Waits (bounded) until at least one `send_attempts` row exists for the
 * fleet's own instances, i.e. until the send loops are actually delivering the
 * seeded backlog. Without this a scenario can hit the fleet BEFORE the first
 * safety poll (30 s prod default) has claimed anything - the first fleet-scale
 * worker-kill did exactly that (P26 run log #21): takeover measured fine, but
 * `sendsObserved = 0`, so "every needs_reconcile explained" held vacuously
 * because nothing was in flight. Returns the count seen (0 on deadline - the
 * scenario still runs and records that honestly; it never fabricates).
 */
export async function warmUpUntilSendsFlow(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
  deadlineMs = 150_000,
): Promise<number> {
  let seen = 0;
  await waitForOutcome(
    async () => {
      seen = await countSendAttempts(pool, instanceIds, clientIds);
      return seen > 0;
    },
    deadlineMs,
    2_000,
  );
  console.log(`run-chaos-fleet: warm-up saw ${String(seen)} send_attempts before the chaos action`);
  return seen;
}
