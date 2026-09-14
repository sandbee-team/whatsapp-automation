import type { createPool } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { bindDiscoveryMetrics } from '../../platform/metrics/discovery-metrics.js';
import {
  readFleetGauges,
  readFleetCapacityHeadroom,
  publishWorkerCap,
  fleetCapsKey,
  withTimeout,
  DiscoveryRedisTimeoutError,
  type FleetGaugesCounts,
  type PublishWorkerCapInput,
  type ReadFleetCapacityHeadroomInput,
} from './discovery-caps.js';
import { isInstanceOwnershipFresh, markInfraUnavailableIfChanged } from './discovery-escalation.js';
import type { AdmissionPort, DiscoveryDeps, DiscoveryLoop } from './discovery-types.js';

// discovery-caps.ts's gauges/worker-cap section, discovery-escalation.ts's
// escalation-write + ownership-freshness section, and discovery-types.ts's
// DiscoveryDeps/AdmissionPort/DiscoveryLoop interfaces were split out at
// FIX-P09-B for the max-lines cap - re-exported here so every existing
// `from './discovery.js'` import keeps working unchanged, and so this
// module still (transitively) imports all three, keeping the placement-
// neutrality guard's coverage intact.
export {
  readFleetGauges,
  readFleetCapacityHeadroom,
  publishWorkerCap,
  fleetCapsKey,
  withTimeout,
  DiscoveryRedisTimeoutError,
  type FleetGaugesCounts,
  type PublishWorkerCapInput,
  type ReadFleetCapacityHeadroomInput,
  isInstanceOwnershipFresh,
  markInfraUnavailableIfChanged,
  type AdmissionPort,
  type DiscoveryDeps,
  type DiscoveryLoop,
};

/**
 * engine/fleet/discovery.ts (P09 Unit U3 step 5) - the fleet-wide discovery
 * loop: on an injected-interval tick (5s +/- 2s jitter, the SAME idiom
 * `roles/session-worker.ts`'s bootstrap-scan timer uses), this module scans
 * for unowned, online-desired instances (via `scanUnowned`'s already-
 * registered `wp_lease_scan_unowned` delegate - see `discover-instances.sql`'s
 * own header for why no new SQL/definer function is introduced here),
 * attempts to grab remaining capacity up to the worker's cap, updates the two
 * fleet gauges, and escalates an instance to `degraded` +
 * `needs_user_action='INFRA_UNAVAILABLE'` after 3 consecutive unowned
 * sightings.
 *
 * PLACEMENT NEUTRALITY (step 9): this module imports no health-scoring,
 * pause, restriction-history or IP-diversity module - the `health_state <>
 * 'logged_out'` predicate lives entirely inside `wp_lease_scan_unowned`
 * (link-liveness only), never re-implemented or re-scored here.
 *
 * FAIL-SAFE (step 6): any query/Redis error this cycle is logged and the
 * cycle backs off (one skipped cycle) - never releases a lease, never ends a
 * socket, never throws out of `runOneCycle`. A Postgres/Redis hiccup must
 * never drop a live socket (ADR 0018 S4); only a fence conflict self-fences.
 */

const SOFT_YIELD_LAG_MS = 200;
const SOFT_YIELD_CAP_FRACTION = 0.9;
const ESCALATION_CYCLE_THRESHOLD = 3;
/**
 * This phase's own discovery staleness window - distinct from
 * `TIMING.leaseTtlMs` (governs the Redis lease TTL, not the Postgres
 * liveness-scan window). P09 FLEET-RECOVERY FIX: originally 45_000ms, which
 * left ZERO slack against the mandatory <=45s-per-instance takeover SLA
 * (`TIMING.leaseTtlMs` 30s + `TIMING.takeoverGraceMs` 15s = 45s) once
 * measured with real timers end-to-end - a row only becomes discoverable
 * `DISCOVERY_STALE_MS` after its `lease_seen_at` heartbeat stamp, and the
 * test's own 45s clock starts at the dead worker's kill, not at that
 * discoverability moment, so the OLD 45_000ms value alone consumed the
 * entire SLA budget before a single grab/acquire could even begin
 * (confirmed live: `fleet-recovery.integration.test.ts`'s kill-9 storm
 * measured every instance grabbed within ~100-700ms of becoming eligible,
 * yet still landed at 44.7-45.6s total because eligibility itself did not
 * arrive until ~44.4-44.9s after kill). 3x `TIMING.heartbeatMs` (10_000ms)
 * = 30_000ms keeps the SAME liveness-detection safety margin
 * `TIMING.leaseTtlMs` itself uses (3 missed heartbeats before treating a
 * worker as gone - never a shorter window that would risk discovering a
 * live-but-briefly-slow-to-renew worker's row as abandoned), while leaving
 * a full 15s of real headroom for the actual grab-and-acquire machinery
 * afterward - which this same fix proved only needs ~100-700ms in
 * practice, so 15s is generous margin, not a razor's edge.
 */
export const DISCOVERY_STALE_MS = 30_000;
const DEFAULT_MAX_ROWS = 50;
const SCAN_INTERVAL_BASE_MS = 5_000;
const SCAN_INTERVAL_JITTER_MS = 2_000;

export interface DiscoveryRow {
  instanceId: string;
  clientId: string;
}

interface ScanUnownedRow extends Record<string, unknown> {
  instance_id: string;
  client_id: string;
}

/**
 * Runs the registered `discover-instances.sql` delegate directly (mirrors
 * `engine/lease/lease-state-repo.ts`'s own `scanUnowned` exactly - duplicated
 * here rather than imported so this module's only dependency on that file is
 * the SQL query loader, never a cross-module deep import of `engine/lease/**`
 * internals).
 */
export async function scanForDiscovery(
  pool: Pick<ReturnType<typeof createPool>, 'query'>,
  input: { staleMs: number; maxRows: number },
): Promise<DiscoveryRow[]> {
  const query = await loadQuery('discover-instances');
  const params = bindQueryParams(query, { stale_ms: input.staleMs, max_rows: input.maxRows });
  const result = await pool.query<ScanUnownedRow>(query.text, params);
  return result.rows.map((row) => ({ instanceId: row.instance_id, clientId: row.client_id }));
}

// ---------------------------------------------------------------------
// Escalation write (3-consecutive-cycle unowned+ungrabbed -> degraded +
// needs_user_action='INFRA_UNAVAILABLE') and the ownership-freshness
// re-check live in discovery-escalation.ts (split out at FIX-P09-B for the
// max-lines cap) - imported above, re-used unchanged here.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// The discovery loop itself. DiscoveryDeps/AdmissionPort/DiscoveryLoop live
// in discovery-types.ts (split out at FIX-P09-B for the max-lines cap) -
// imported above, re-used unchanged here.
// ---------------------------------------------------------------------

function scanIntervalMs(random: () => number): number {
  const jitter = (random() * 2 - 1) * SCAN_INTERVAL_JITTER_MS;
  return SCAN_INTERVAL_BASE_MS + jitter;
}

/**
 * Builds the discovery loop. `runOneCycle` is the deterministic unit under
 * test - it never sleeps and never starts its own timer; `start()`/`stop()`
 * wrap it in the injected-interval timer for production use.
 */
export function createDiscoveryLoop(deps: DiscoveryDeps): DiscoveryLoop {
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;
  const staleMs = deps.staleMs ?? DISCOVERY_STALE_MS;
  const metrics = deps.metrics ?? bindDiscoveryMetrics();
  const random = deps.random ?? Math.random;
  const onCycleError =
    deps.onCycleError ??
    ((err: unknown) => {
      console.error(`discovery: cycle failed: ${describeError(err)}`);
    });

  /** instanceId -> consecutive cycles seen unowned AND not grabbed by anyone. */
  const consecutiveUnowned = new Map<string, number>();
  /** instanceId -> clientId, so a later cycle's escalation write knows the tenant scope even if the row is momentarily absent from the current scan. */
  const lastKnownClientId = new Map<string, string>();

  async function runOneCycle(): Promise<void> {
    try {
      const admissionResult = deps.admission.canAcceptLease();
      if (!admissionResult.ok) {
        // step 1: admission holding - skip scanning/grabbing entirely this
        // cycle (zero grab calls while holding).
        return;
      }

      const rows = await scanForDiscovery(deps.pool, { staleMs, maxRows });

      const seenThisCycle = new Set<string>();
      let remainingCapacity = Math.max(0, deps.getCap() - deps.getCurrentSessions());

      const softYieldLagBreached = deps.getLagP99Ms() > SOFT_YIELD_LAG_MS;
      const softYieldThreshold = SOFT_YIELD_CAP_FRACTION * deps.getCap();

      for (const row of rows) {
        seenThisCycle.add(row.instanceId);
        lastKnownClientId.set(row.instanceId, row.clientId);

        // step 2: soft yield at 0.9x cap under sustained lag - stop grabbing
        // this cycle once sessions reach the threshold, but keep the scan
        // pass (for escalation bookkeeping) going.
        if (softYieldLagBreached && deps.getCurrentSessions() >= softYieldThreshold) {
          continue;
        }
        if (remainingCapacity <= 0) {
          continue;
        }

        const grabbed = await deps.grab(row);
        if (grabbed) {
          remainingCapacity -= 1;
          consecutiveUnowned.delete(row.instanceId);
          continue;
        }

        // WARNING FIX 5: a failed/lost grab this cycle does NOT automatically
        // count toward escalation - re-verify ownership freshness first. An
        // instance someone else already holds a FRESH lease for merely lost
        // the grab RACE (contended, healthy) and must reset/skip the streak,
        // never be escalated toward INFRA_UNAVAILABLE alongside a genuinely
        // unowned instance.
        const ownedFresh = deps.isOwnershipFresh ? await deps.isOwnershipFresh(row) : false;
        if (ownedFresh) {
          consecutiveUnowned.delete(row.instanceId);
          continue;
        }

        // Still genuinely unowned after a failed grab attempt this cycle -
        // counts toward escalation.
        const next = (consecutiveUnowned.get(row.instanceId) ?? 0) + 1;
        consecutiveUnowned.set(row.instanceId, next);
      }

      // Any previously-tracked instance ABSENT from this cycle's scan is no
      // longer unowned (grabbed by someone, no longer online-desired, or
      // deleted) - drop its streak rather than let a stale streak survive.
      for (const instanceId of [...consecutiveUnowned.keys()]) {
        if (!seenThisCycle.has(instanceId)) {
          consecutiveUnowned.delete(instanceId);
          lastKnownClientId.delete(instanceId);
        }
      }

      for (const [instanceId, count] of consecutiveUnowned) {
        if (count < ESCALATION_CYCLE_THRESHOLD) continue;
        const clientId = lastKnownClientId.get(instanceId);
        if (!clientId) continue;
        await deps.markInfraUnavailable({ instanceId, clientId });
      }

      const gauges = await readFleetGauges(deps.pool);
      const headroom = await readFleetCapacityHeadroom({
        redis: deps.redis,
        env: deps.env,
        desiredOnlineCount: gauges.desiredOnlineCount,
      });
      metrics.instancesUnowned.set(gauges.unownedCount);
      metrics.fleetCapacityHeadroom.set(headroom);
    } catch (err) {
      // Fail-safe (step 6): a query/Redis error backs off one cycle - never
      // releases a lease, never ends a socket, never throws out of the loop.
      onCycleError(err);
    }
  }

  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  function scheduleNext(): void {
    if (stopped) return;
    timerHandle = setTimeoutFn(() => {
      void runOneCycle().finally(scheduleNext);
    }, scanIntervalMs(random));
  }

  return {
    runOneCycle,
    start(): void {
      stopped = false;
      scheduleNext();
    },
    stop(): void {
      stopped = true;
      if (timerHandle !== undefined) {
        clearTimeoutFn(timerHandle);
      }
    },
  };
}
