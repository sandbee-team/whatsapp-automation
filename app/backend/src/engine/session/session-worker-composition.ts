import type { Redis } from 'ioredis';
import { TIMING as DEFAULT_TIMING } from '@wp/domain';
import { createPool, type TenantDb, type WorkerDb } from '@wp/db';
import { logger } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { bindSignalMetrics } from '../../platform/metrics/signal-metrics.js';
import { bindLeaseMetrics } from '../../platform/metrics/lease-metrics.js';
import { LeaseManager } from '../lease/lease-manager.js';
import { LeaseHeartbeat } from '../lease/heartbeat.js';
import { createLeaseRedis } from '../lease/lease-redis.js';
import { readFleetGauges } from '../fleet/discovery.js';
import {
  createSessionRegistry,
  createSessionOwner,
  type SessionRunnerRegistry,
} from './registry.js';
import type { SessionLease } from '../lease/lease-manager.js';
import { createPerWorkerConnectGate } from './connect-gate.js';
import { buildSessionInventory } from './fleet-adapters.js';
import { wireFleetRuntime, buildFleetConnectGate } from '../fleet/fleet-wiring.js';
import { bindFleetMetrics } from '../fleet/metrics.js';
import { buildDiscoveryWiring } from './session-worker-discovery-wiring.js';
import { sweepTeardowns } from './session-worker-sweep.js';
import type { FakeableSocket, RunnerPublish } from './runner-types.js';

/**
 * session-worker-composition.ts (P08 U6b PART 1, extended P09 U6 step 9) -
 * the `createSessionWorker` factory: everything `roles/session-worker.ts`'s
 * `main()` wires, minus the process-boundary concerns (env/config parsing,
 * SIGTERM/SIGINT, boot-order preconditions), which stay in the thin
 * entrypoint split out purely to keep both under max-lines.
 *
 * `createDiscoveryLoop` (unowned/online instance discovery, under admission
 * control) provides `runOneDiscoveryCycle()`/`startDiscovered()` (test/
 * production seams); `runOneScanIteration` drives discovery+sweep via that
 * loop. `sweepTeardowns` parks/tears down ALREADY-HELD instances gone
 * offline/deleted.
 *
 * Test seam: `createSessionWorker(deps)` takes already-connected pg/redis
 * handles and an already-resolved `socketFactory` - nothing in this module
 * reads `process.env` or opens its own connections.
 */

export interface CreateSessionWorkerDeps {
  env: string;
  workerId: string;
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  workerDb: WorkerDb;
  redisCtl: Redis;
  redisSig: Redis;
  redisCache: Redis;
  keyProvider: KeyProvider;
  encVersion?: number;
  socketFactory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  /** Bounds the discovery loop's `maxRows` per cycle (default 50); tests against a shared dev DB pass a small value so a scan cannot fan out into unrelated lease-acquire attempts on other suites' `desired_state='online'` rows. */
  maxScanRows?: number;
  /** P10 U5-followup: the two Signal caps from config (both default 4000, provisional until P10a M3), forwarded via `buildDiscoveryWiring`. */
  signalKeystoreMaxRecords?: number;
  maxFieldsPerInstance?: number;
  /** Defaults to a safe no-op - `roles/session-worker.ts` overrides this with the real cross-process publisher (`modules/realtime/redis-bridge.ts`). */
  publish?: RunnerPublish;
  /** This worker's derived session cap (`fleet-wiring.ts`'s `bootWorkerBudget` output) - defaults to a generous 250 (the absolute ceiling, `budget.ts`'s `SESSION_CAP_CEILING`) so a caller that has not wired the real budget yet still gets a workable default in tests. */
  sessionCap?: number;
  /** RSS budget in bytes for the admission controller - defaults to a generous 3GB so tests that never sample stay in `accepting`. */
  budgetBytes?: number;
  /** Overrides `@wp/domain`'s `TIMING` for `LeaseManager` (defaults to the real, uncompressed `TIMING`) - the same compressed-timing test seam `session-worker-two-workers.c2.integration.test.ts` already uses directly against `LeaseManager`, now exposed here so discovery-driven tests are not forced to pay a real 15s `takeoverGraceMs` per grabbed instance. */
  timing?: typeof DEFAULT_TIMING;
}

export interface SessionWorker {
  /** Runs exactly ONE discovery+sweep iteration (start newly-discovered instances via `createDiscoveryLoop`, park/teardown any registry entry that is no longer online/deleted). Test seam for the discovery-driven successor of `session-worker-scan.integration.test.ts`; production wiring calls this on the injected-interval timer. */
  runOneScanIteration(): Promise<void>;
  /** Runs exactly one `createDiscoveryLoop` cycle without the teardown sweep - the narrower seam for discovery-only assertions. */
  runOneDiscoveryCycle(): Promise<void>;
  /** Builds+starts ONE runner through the REAL `buildSessionRunnerFor` composition (the exact per-row call `runOneDiscoveryCycle`'s `grab` makes internally) for a caller-supplied `(instanceId, clientId)`, bypassing the `ORDER BY random()` scan entirely. Test seam only: lets a fence-liveness/composition test drive a deterministic instance through the real factory without racing a shared-dev-database scan for an unbounded number of cycles (see `session-worker-composition.fence-liveness.integration.test.ts`). `waveConnect` always `false` (an uncontended, directly-driven grab, not a fleet-restart decorrelation case). Returns `true` iff the lease was acquired. */
  startDiscoveredForTest(instanceId: string, clientId: string): Promise<boolean>;
  /** Snapshot of how many sessions this worker currently holds a live handle for. */
  registrySize(): number;
  /** Tears down every held session (WITH release) and stops the heartbeat - does NOT close the pg/redis handles this worker was constructed with (the caller, `roles/session-worker.ts`, owns those). */
  shutdown(): Promise<void>;
  /** Flips this worker's admission controller into `draining` (terminal) - `roles/session-worker.ts`'s SIGTERM/SIGINT handler's `beginDrain` port. */
  beginDrain(): void;
  /** The live session registry - `roles/session-worker.ts`'s drain wiring builds its `DrainSession[]` port over this via `fleet-adapters.ts#buildDrainSessions`. */
  readonly registry: SessionRunnerRegistry;
  /** This worker's `LeaseManager` - the drain wiring's graceful-release port. */
  readonly leaseManager: LeaseManager;
  /** The CURRENT held lease for `instanceId`, or `undefined` if not held - the same authoritative `heartbeat.held()` lookup `currentFence` uses internally, exposed for the drain/shed adapters' `getLease` port. */
  getHeldLease(instanceId: string): SessionLease | undefined;
  /**
   * SIGKILL-semantics test seam (P09 U7 step 10): stops ONLY this worker's
   * heartbeat renewal timer - no lease release, no socket end, no registry
   * mutation, nothing else. `shutdown()` deliberately does NOT model a real
   * `kill -9` (it gracefully releases every held lease first); a real hard
   * kill leaves every held Redis/Postgres lease row exactly as it was and
   * simply stops renewing it, which is what lets `wp_lease_scan_unowned`'s
   * `lease_seen_at` staleness predicate eventually treat it as unowned
   * again after `DISCOVERY_STALE_MS`/`leaseTtlMs`. Never used by production
   * wiring (`roles/session-worker.ts` never calls this) - a real process
   * dying stops its own heartbeat by simply ceasing to exist; this method
   * only exists because an in-process test harness (`synthetic-fleet-
   * support.ts`) has no OS process boundary to rely on for the same effect.
   */
  stopHeartbeatOnly(): Promise<void>;
  /** Test seam (P26 U6a) - passes through `LeaseHeartbeat.isClaimingAllowed()` for a test's bounded poll. */
  claimingAllowed(): boolean;
}

const NOOP_PUBLISH: RunnerPublish = () => undefined;

export function createSessionWorker(deps: CreateSessionWorkerDeps): SessionWorker {
  const { env, workerId, pool, tenantDb, workerDb, redisCtl, redisSig, redisCache } = deps;
  const publish = deps.publish ?? NOOP_PUBLISH;
  const encVersion = deps.encVersion ?? 1;

  const timing = deps.timing ?? DEFAULT_TIMING;
  const signalMetrics = bindSignalMetrics();
  const leaseRedis = createLeaseRedis(redisCtl, {
    timeoutMs: timing.redisCommandTimeoutMs,
  });
  const registry = createSessionRegistry();
  const sessionOwner = createSessionOwner(registry);

  // Wires the two `LeaseManager`-owned metrics (`wp_lease_takeovers_total`,
  // `wp_fence_regression_total`) into the SHARED default registry
  // (`bindLeaseMetrics`'s own default param) - previously omitted here, so
  // `LeaseManager` silently fell back to its `NOOP_METRICS` default and
  // neither counter was ever incremented by a real composed worker. Fixed
  // as part of P09 U7 (the fleet integration harness needs
  // `wp_fence_regression_total` to be real for its
  // `takeover_does_not_regress_the_fence` assertion) - same idempotent-bind
  // pattern `bindFleetMetrics`/`bindSignalMetrics` already use in this file.
  const leaseMetrics = bindLeaseMetrics();
  const leaseManager = new LeaseManager({
    leaseRedis,
    tenantDb,
    sessionOwner,
    workerId,
    env,
    timing,
    metrics: leaseMetrics,
  });
  const heartbeat = new LeaseHeartbeat({
    leaseRedis,
    pgSql: workerDb,
    sessionOwner,
    workerId,
    env,
    // P26 U6a fix: `timing` reached LeaseManager above but never the
    // heartbeat - additive (omitted `deps.timing` still defaults to the
    // real `TIMING`, so every existing caller is unaffected).
    timing,
  });
  heartbeat.start();

  const perWorkerGate = createPerWorkerConnectGate({
    ratePerSec: 2,
    burst: 5,
    clock: { now: () => Date.now() },
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
  });

  const currentSessionCap = deps.sessionCap ?? 250;
  const budgetBytes = deps.budgetBytes ?? 3 * 1024 * 1024 * 1024;
  const fleetMetrics = bindFleetMetrics();

  // `AdmissionController.getFleetHeadroom()` is a SYNCHRONOUS read but the
  // real headroom source (`readFleetCapacityHeadroom`) is a Redis round
  // trip - refreshed once per discovery cycle (which already pays that
  // round trip for its own gauge update) and read synchronously here.
  // `null` (never sampled yet) is treated as ZERO by admission.ts itself
  // (fail-safe: never shed into an unknown fleet).
  let cachedFleetHeadroom: number | null = null;

  // P09 fleet runtime: sampler -> admission.onSample + gauges, and
  // admission.victimChooser -> shed.chooseShedVictims over the REAL session
  // inventory adapter (buildSessionInventory over this worker's own
  // registry).
  const fleetRuntime = wireFleetRuntime({
    getSessions: () => registry.size,
    getCap: () => currentSessionCap,
    budgetBytes,
    getFleetHeadroom: () => cachedFleetHeadroom,
    sessionInventory: buildSessionInventory(registry),
    raiseCapacityAlert: (reason) => {
      logger.warn({}, `fleet capacity alert: ${reason}`);
    },
    raiseThrashing: () => {
      logger.warn({}, 'fleet worker.thrashing: 3 shed episodes within the rolling 1h window');
    },
  });

  // The fleet-wide ConnectGate (requirement 1): composes the per-worker gate
  // with the real Redis fleet token bucket + outage tracker, swapped in
  // behind the SAME `ConnectGate` interface `buildSessionRunnerFor` already
  // consumes - callers never see the difference (P08's own handoff note).
  const connectGate = buildFleetConnectGate({
    perWorkerGate,
    redis: deps.redisCtl,
    env,
    getDesiredOnline: async () => {
      // Fleet-wide desired-online COUNT, the same `fleet-gauges.sql`-backed
      // read `readOneDiscoveryCycle` uses for its own cache refresh - a
      // per-`take()` Redis+PG round trip, no additional query added.
      const gauges = await readFleetGauges(pool);
      return gauges.desiredOnlineCount;
    },
    onWait: (seconds) => {
      fleetMetrics.connectBucketWaitSeconds.observe(seconds);
    },
  });

  /** The CURRENT fence this worker holds for `instanceId`, read from the heartbeat's own held-lease bookkeeping (the one authoritative place). */
  function currentFence(instanceId: string): bigint {
    const held = heartbeat.held().find((lease) => lease.instanceId === instanceId);
    return held?.fence ?? 0n;
  }

  // The discovery cycle assembly lives in session-worker-discovery-wiring.ts
  // (split out at FIX-P09-B for the max-lines cap). Pure code motion:
  // `setCachedFleetHeadroom` closes over this function's own `cachedFleetHeadroom`
  // field so `fleetRuntime.getFleetHeadroom` above reads the SAME cache.
  const { runOneDiscoveryCycle, startDiscovered } = buildDiscoveryWiring({
    env,
    workerId,
    pool,
    tenantDb,
    redisSig,
    redisCache,
    redisCtl: deps.redisCtl,
    keyProvider: deps.keyProvider,
    encVersion,
    signalMetrics,
    signalKeystoreMaxRecords: deps.signalKeystoreMaxRecords,
    maxFieldsPerInstance: deps.maxFieldsPerInstance,
    leaseManager,
    heartbeat,
    registry,
    sessionOwner,
    connectGate,
    publish,
    socketFactory: deps.socketFactory,
    currentFence,
    admission: fleetRuntime.admission,
    currentSessionCap,
    maxScanRows: deps.maxScanRows,
    setCachedFleetHeadroom: (headroom) => {
      cachedFleetHeadroom = headroom;
    },
  });

  // sweepTeardowns (parking/tearing down ALREADY-HELD instances gone
  // offline/deleted) lives in session-worker-sweep.ts (split out at
  // FIX-P09-B for the max-lines cap) - see that module's own doc comment.
  // Pure code motion, unrelated to the discovery-loop wiring above.

  return {
    async runOneScanIteration(): Promise<void> {
      await runOneDiscoveryCycle();
      await sweepTeardowns(tenantDb, registry);
    },

    runOneDiscoveryCycle,

    startDiscoveredForTest: (instanceId: string, clientId: string) =>
      startDiscovered(instanceId, clientId, false),

    registrySize(): number {
      return registry.size;
    },

    async shutdown(): Promise<void> {
      for (const handle of [...registry.values()]) {
        await handle.teardownWithRelease();
      }
      await heartbeat.stop();
    },

    beginDrain(): void {
      fleetRuntime.admission.beginDrain();
    },

    registry,
    leaseManager,

    getHeldLease(instanceId: string): SessionLease | undefined {
      return heartbeat.held().find((lease) => lease.instanceId === instanceId);
    },

    async stopHeartbeatOnly(): Promise<void> {
      await heartbeat.stop();
    },

    claimingAllowed(): boolean {
      return heartbeat.isClaimingAllowed();
    },
  };
}
