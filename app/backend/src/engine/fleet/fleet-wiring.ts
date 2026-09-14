import type { Redis } from 'ioredis';
import { TIMING } from '@wp/domain';
import type { createPool } from '@wp/db';
import { sysKey } from '../../platform/redis/keys.js';
import { deriveSessionCapResult, assertHeapBudgetMatchesNodeFlags } from './budget.js';
import { bindFleetMetrics } from './metrics.js';
import { createFleetSampler, defaultReadBoxRssBytes, type FleetSamplerDeps } from './sampler.js';
import { createAdmissionController } from './admission.js';
import { instanceConnectOffsetMs } from './connect-budget.js';
import {
  createRedisOutagePort,
  buildFleetConnectGate,
  type BuildFleetConnectGateOptions,
} from './fleet-wiring-connect-gate.js';
import { chooseShedVictims, type SessionInventory, type ShedCandidate } from './shed.js';
import { createDiscoveryLoop, type DiscoveryDeps, type DiscoveryRow } from './discovery.js';
import type { InstanceId } from './types.js';

/**
 * fleet-wiring.ts (P09 U6 step 9) - the composition adapters wiring
 * `engine/fleet/**`'s pure modules (budget/metrics/sampler/admission/
 * connect-budget/shed/discovery) into ONE fleet layer a role/composition
 * module can bind to a live worker. PORTS ONLY - this file never imports the
 * baileys provider layer or anything under `engine/session/**` that itself
 * imports it (the shutdown-purity guard over this module graph lands in a
 * parallel unit; the concrete adapters that DO touch sockets/pairing live in
 * `engine/session/**`/`roles/**`, which construct their own
 * `SessionInventory`/`ShedPorts`/`DrainSession` implementations and pass
 * them in from the outside).
 */

// ---------------------------------------------------------------------
// 1. Boot-time budget: deriveSessionCap + the heap-flag assertion, in one
//    call so wiring never forgets one half (core invariant 2, fail-safe).
// ---------------------------------------------------------------------

export interface WorkerBudgetBootConfig {
  heapBudgetMb: number;
  processBaselineMb: number;
  plannedSessionMb: number;
  measuredSessionMb?: number;
  safetyFactor: number;
}

export interface BootWorkerBudgetResult {
  cap: number;
  /** `true` when `measuredSessionMb` was absent and the cap rests on the derived `plannedSessionMb` bracket rather than a real measurement (P10 U6 step 7) - callers tag their cap gauge/boot log with this so operators can see "this cap is not yet measurement-backed" at a glance. */
  provisional: boolean;
}

/**
 * Asserts `assertHeapBudgetMatchesNodeFlags` (throws `HeapBudgetMismatchError`
 * on a mismatch - callers let this propagate, refusing to boot per core
 * invariant 2) THEN derives the session cap AND its `provisional` tag via
 * `deriveSessionCapResult`. Always both assert-then-derive, always in this
 * order - a cap derived before the flag assertion would be a cap the process
 * cannot actually honor.
 */
export function bootWorkerBudget(
  cfg: WorkerBudgetBootConfig,
  execArgv: readonly string[],
  nodeOptionsEnv: string | undefined,
): BootWorkerBudgetResult {
  assertHeapBudgetMatchesNodeFlags(cfg, execArgv, nodeOptionsEnv);
  const { cap, provisional } = deriveSessionCapResult({
    heapBudgetMb: cfg.heapBudgetMb,
    processBaselineMb: cfg.processBaselineMb,
    plannedSessionMb: cfg.plannedSessionMb,
    measuredSessionMb: cfg.measuredSessionMb,
    safetyFactor: cfg.safetyFactor,
  });
  return { cap, provisional };
}

// ---------------------------------------------------------------------
// 2-3. Real OutageRedisPort + the fleet ConnectGate wiring (per-worker gate
//    + fleet token bucket + outage tracker) - split out into
//    fleet-wiring-connect-gate.ts at FIX-P09-B for the max-lines cap,
//    re-exported here so every existing import path keeps working.
// ---------------------------------------------------------------------

export { createRedisOutagePort, buildFleetConnectGate, type BuildFleetConnectGateOptions };

export { instanceConnectOffsetMs };

// ---------------------------------------------------------------------
// 4. Fleet metrics/sampler/admission wiring - binds the sampler's onSample
//    into BOTH admission.onSample and the five gauges, and admission's
//    victimChooser into shed.chooseShedVictims over an injected
//    SessionInventory.
// ---------------------------------------------------------------------

export interface WireFleetRuntimeOptions {
  getSessions: () => number;
  getCap: () => number;
  budgetBytes: number;
  getFleetHeadroom: () => number | null;
  sessionInventory: SessionInventory;
  raiseCapacityAlert(reason: string): void;
  raiseThrashing(): void;
  now?: () => number;
  monotonicNow?: () => number;
  samplerDeps?: Partial<FleetSamplerDeps>;
}

export interface FleetRuntime {
  sampleOnce: () => void;
  admission: ReturnType<typeof createAdmissionController>;
  chooseShedVictims(n: number): InstanceId[];
}

/**
 * Wires sampler -> (admission.onSample + the five worker/fleet gauges) and
 * admission's `victimChooser` -> `shed.chooseShedVictims` over the injected
 * `SessionInventory` snapshot (never a raw registry reach-through - shed
 * selection stays a pure function of the snapshot, per shed.ts's own
 * PLACEMENT NEUTRALITY doc). The caller owns the 5s interval that calls
 * `sampleOnce()` - this module starts no timer of its own (mirrors
 * `createFleetSampler`'s own "caller owns the interval" contract).
 */
export function wireFleetRuntime(options: WireFleetRuntimeOptions): FleetRuntime {
  const metrics = bindFleetMetrics();
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  function victimChooser(n: number): InstanceId[] {
    const candidates: ShedCandidate[] = options.sessionInventory.snapshot();
    return chooseShedVictims(candidates, n, monotonicNow());
  }

  const admission = createAdmissionController({
    getCap: options.getCap,
    budgetBytes: options.budgetBytes,
    getFleetHeadroom: options.getFleetHeadroom,
    victimChooser,
    raiseCapacityAlert: options.raiseCapacityAlert,
    raiseThrashing: options.raiseThrashing,
    now,
  });

  const sampler = createFleetSampler(
    {
      now: monotonicNow,
      getSessions: options.getSessions,
      getCap: options.getCap,
      readRssBytes: options.samplerDeps?.readRssBytes ?? (() => process.memoryUsage().rss),
      readHeapOldSpaceBytes:
        options.samplerDeps?.readHeapOldSpaceBytes ?? (() => process.memoryUsage().heapUsed),
      readEventLoopLagP99Ms: options.samplerDeps?.readEventLoopLagP99Ms ?? (() => 0),
      readGcPauseP99Ms: options.samplerDeps?.readGcPauseP99Ms ?? (() => 0),
      readBoxRssBytes: options.samplerDeps?.readBoxRssBytes ?? defaultReadBoxRssBytes,
      ringBufferCapacity: options.samplerDeps?.ringBufferCapacity,
    },
    (sample) => {
      admission.onSample(sample);
      metrics.workerSessions.set(sample.sessions);
      metrics.eventLoopLagP99.set(sample.eventLoopLagP99Ms);
      metrics.boxRssBytes.set(defaultReadBoxRssBytes());
      metrics.workerSessionCap.set(options.getCap());
      const slope = sampler.currentSessionRssSlopeBytes();
      if (slope !== null) {
        metrics.sessionRssBytesEst.set(slope);
      }
    },
  );

  return {
    sampleOnce: () => {
      sampler.sampleOnce();
    },
    admission,
    chooseShedVictims: victimChooser,
  };
}

// ---------------------------------------------------------------------
// 5. Discovery loop wiring helper - thin pass-through so callers do not
//    need to import discovery.ts directly for the common case.
// ---------------------------------------------------------------------

export interface BuildDiscoveryLoopOptions {
  pool: Pick<ReturnType<typeof createPool>, 'query'>;
  redis: Redis;
  env: string;
  workerId: string;
  admission: { canAcceptLease(): { ok: boolean; state: string; reason?: string } };
  grab(row: DiscoveryRow): Promise<boolean>;
  markInfraUnavailable(row: DiscoveryRow): Promise<boolean>;
  /** WARNING FIX 5 - see `discovery.ts`'s own `DiscoveryDeps.isOwnershipFresh` doc comment. Optional pass-through - omitted callers keep the pre-fix "every failed grab counts toward escalation" behavior. */
  isOwnershipFresh?(row: DiscoveryRow): Promise<boolean>;
  getLagP99Ms(): number;
  getCap(): number;
  getCurrentSessions(): number;
  onCycleError?: (err: unknown) => void;
  /** Passed straight through to `discovery.ts`'s own `maxRows` (default 50) - callers bound a small value in a shared/polluted test database to keep one cycle from fanning out into many unrelated real lease-acquire attempts. */
  maxRows?: number;
}

export function buildDiscoveryLoop(
  options: BuildDiscoveryLoopOptions,
): ReturnType<typeof createDiscoveryLoop> {
  const deps: DiscoveryDeps = {
    pool: options.pool,
    redis: options.redis,
    env: options.env,
    workerId: options.workerId,
    admission: options.admission,
    grab: options.grab,
    markInfraUnavailable: options.markInfraUnavailable,
    isOwnershipFresh: options.isOwnershipFresh,
    getLagP99Ms: options.getLagP99Ms,
    getCap: options.getCap,
    getCurrentSessions: options.getCurrentSessions,
    onCycleError: options.onCycleError,
    maxRows: options.maxRows,
  };
  return createDiscoveryLoop(deps);
}

export { sysKey, TIMING };
