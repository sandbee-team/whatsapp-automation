import type { Redis } from 'ioredis';
import type { createPool, TenantDb } from '@wp/db';
import { logger, describeError } from '@wp/server-kit';
import type { KeyProvider } from '@wp/server-kit/crypto';
import type { SignalMetricsHandles } from '../../platform/metrics/signal-metrics.js';
import {
  createWorkerInboundAdmission,
  createWorkerInboundLimiter,
  buildInboundSocketHandlers,
} from './session-worker-inbound-wiring.js';
import {
  DISCOVERY_STALE_MS,
  isInstanceOwnershipFresh,
  markInfraUnavailableIfChanged,
  publishWorkerCap,
  readFleetCapacityHeadroom,
  readFleetGauges,
  type DiscoveryLoop,
  type DiscoveryRow,
} from '../fleet/discovery.js';
import { buildDiscoveryLoop } from '../fleet/fleet-wiring.js';
import { createWaveConnectTracker } from './connect-offset-wave.js';
import { buildSessionRunnerFor } from './session-worker-runner-factory.js';
import type { LeaseManager } from '../lease/lease-manager.js';
import type { LeaseHeartbeat } from '../lease/heartbeat.js';
import type { ConnectGate } from './connect-gate.js';
import type { SessionRunnerRegistry } from './registry.js';
import type { SessionOwner } from '../lease/session-owner.port.js';
import type { AdmissionPort } from '../fleet/discovery-types.js';
import type { FakeableSocket, RunnerPublish } from './runner-types.js';

/**
 * session-worker-discovery-wiring.ts (FIX-P09-B split) - the P09 fleet-
 * wiring section (discovery cycle assembly, `startDiscovered`, worker-cap
 * publish, and the fleet-headroom cache refresh), mechanically extracted
 * out of `session-worker-composition.ts` for the max-lines cap. Pure code
 * motion: explicit parameters replace closed-over module state
 * (`CreateSessionWorkerDeps` surface for its own tests stays unchanged -
 * this module is an internal implementation detail of
 * `createSessionWorker`, never imported directly by any test). No logic
 * change.
 */

export interface BuildDiscoveryWiringInput {
  env: string;
  workerId: string;
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  redisSig: Redis;
  redisCache: Redis;
  redisCtl: Redis;
  keyProvider: KeyProvider;
  encVersion: number;
  signalMetrics: SignalMetricsHandles;
  leaseManager: LeaseManager;
  heartbeat: LeaseHeartbeat;
  registry: SessionRunnerRegistry;
  sessionOwner: SessionOwner;
  connectGate: ConnectGate;
  publish: RunnerPublish;
  socketFactory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  currentFence: (instanceId: string) => bigint;
  admission: AdmissionPort;
  currentSessionCap: number;
  maxScanRows: number | undefined;
  /** Setter for the worker's own `cachedFleetHeadroom` field - called once per discovery cycle with the freshly-read headroom, or left untouched on a failed refresh (fail-safe: never clobber a real prior reading with an error-driven guess). */
  setCachedFleetHeadroom: (headroom: number) => void;
  /** P10 U5-followup: `config.SIGNAL_KEYSTORE_MAX_RECORDS`, carried through to every `buildSessionRunnerFor` call this wiring makes. Optional - see that option's own doc comment for the fail-safe default. */
  signalKeystoreMaxRecords?: number;
  /** P10 U5-followup: `config.REDIS_SIG_MAX_FIELDS_PER_INSTANCE`, carried through to every `buildSessionRunnerFor` call this wiring makes. Optional - see that option's own doc comment for the fail-safe default. */
  maxFieldsPerInstance?: number;
}

export interface DiscoveryWiring {
  discoveryLoop: DiscoveryLoop;
  /** Builds+starts ONE runner for `(instanceId, clientId)` through the real `buildSessionRunnerFor` composition - the exact call `grab` below makes per discovered row (`waveConnect` gates the P09 connect-offset decorrelation delay; a directly-driven test caller passes `false`, matching an uncontended first grab). Exposed so `session-worker-composition.ts` can re-export it as a direct test seam (`startDiscoveredForTest`) that bypasses the `ORDER BY random()` scan. Returns `true` iff the lease was acquired. */
  startDiscovered(instanceId: string, clientId: string, waveConnect: boolean): Promise<boolean>;
  /**
   * Runs the discovery loop's own `runOneCycle` (start newly-discovered,
   * unowned/online instances up to this worker's cap, under admission
   * control), then refreshes the caller's cached fleet headroom from the
   * SAME `readFleetCapacityHeadroom` read the cycle itself just paid for -
   * `AdmissionController.getFleetHeadroom()` stays a synchronous, cheap
   * cache read on every sampler tick, never a fresh Redis round trip per
   * `onSample` call.
   *
   * CRITICAL 2 FIX (C1 review): `publishWorkerCap` had zero production
   * callers, so `readFleetCapacityHeadroom` always summed an empty Redis
   * hash - real fleet-wide shedding headroom was structurally unreachable
   * outside tests that inject a fake headroom directly. This worker now
   * publishes its OWN cap into the shared hash once per discovery cycle
   * (same cadence as the headroom refresh below, which reads that SAME
   * hash back) - a fail-safe no-op on error (core invariant 2: a failed
   * publish must never crash the cycle or be treated as "this worker has
   * zero capacity"; it just leaves the worker's LAST published cap in
   * place until it ages out past `CAP_FRESHNESS_MS`).
   */
  runOneDiscoveryCycle(): Promise<void>;
}

export function buildDiscoveryWiring(input: BuildDiscoveryWiringInput): DiscoveryWiring {
  const {
    env,
    workerId,
    pool,
    tenantDb,
    redisSig,
    redisCache,
    redisCtl,
    keyProvider,
    encVersion,
    signalMetrics,
    leaseManager,
    heartbeat,
    registry,
    sessionOwner,
    connectGate,
    publish,
    socketFactory,
    currentFence,
    admission,
    currentSessionCap,
    maxScanRows,
    setCachedFleetHeadroom,
    signalKeystoreMaxRecords,
    maxFieldsPerInstance,
  } = input;

  // P09 U6b: tracks how many grab ATTEMPTS the current discovery cycle has
  // made so far - `waveConnectTracker.beginCycle()` resets it at the top of
  // every `runOneDiscoveryCycle()`, and each `grab(row)` call notes one
  // attempt. See connect-offset-wave.ts's own doc comment for the exact
  // counting rule.
  const waveConnectTracker = createWaveConnectTracker();

  // P21 U6b, step 7: ONE inbound admission bucket per worker, shared across
  // every session this worker starts (the Redis key itself stays per-
  // instance - see admission.ts). The per-session echo/signals/receipt/
  // dead-letter handlers (formerly this file's own `buildOnMessagesUpsert`,
  // P12 U3) now live in session-worker-inbound-wiring.ts, built fresh per
  // `startDiscovered` call below. C1 fix round: the in-flight limiter is
  // also built ONCE here, beside the admission bucket (reviewer MAJOR).
  const inboundAdmission = createWorkerInboundAdmission({ env, tenantDb, redisCtl });
  const inboundLimiter = createWorkerInboundLimiter({});

  async function startDiscovered(
    instanceId: string,
    clientId: string,
    waveConnect: boolean,
  ): Promise<boolean> {
    const inbound = buildInboundSocketHandlers({
      env,
      tenantDb,
      redisCtl,
      keyProvider,
      encVersion,
      clientId,
      instanceId,
      admission: inboundAdmission,
      limiter: inboundLimiter,
    });
    const runner = buildSessionRunnerFor({
      instanceId,
      clientId,
      env,
      workerId,
      pool,
      tenantDb,
      redisSig,
      redisCache,
      provider: keyProvider,
      encVersion,
      signalMetrics,
      leaseManager,
      heartbeat,
      registry,
      sessionOwner,
      connectGate,
      publish,
      socketFactory,
      currentFence,
      signalKeystoreMaxRecords,
      maxFieldsPerInstance,
      onMessagesUpsert: inbound.onMessagesUpsert,
      onMessagesUpdate: inbound.onMessagesUpdate,
      onMessageReceiptUpdate: inbound.onMessageReceiptUpdate,
    });
    const result = await runner.start({
      instanceId,
      clientId,
      method: 'qr',
      waveConnect,
    });
    return result !== 'not_acquired';
  }

  const discoveryLoop = buildDiscoveryLoop({
    pool,
    redis: redisCtl,
    env,
    workerId,
    admission,
    grab: async (row: DiscoveryRow): Promise<boolean> => {
      const waveConnect = waveConnectTracker.noteGrabAttempt();
      if (registry.has(row.instanceId)) {
        return true;
      }
      return startDiscovered(row.instanceId, row.clientId, waveConnect);
    },
    markInfraUnavailable: async (row: DiscoveryRow): Promise<boolean> =>
      tenantDb.withTenant(row.clientId, (sql) =>
        markInfraUnavailableIfChanged(sql, {
          instanceId: row.instanceId,
          clientId: row.clientId,
        }),
      ),
    // WARNING FIX 5: re-verify ownership freshness before an instance's
    // failed-grab cycle counts toward the INFRA_UNAVAILABLE escalation
    // streak - a contended-but-healthy instance (someone else holds a
    // fresh lease) must reset/skip the streak, never escalate.
    isOwnershipFresh: async (row: DiscoveryRow): Promise<boolean> =>
      tenantDb.withTenant(row.clientId, (sql) =>
        isInstanceOwnershipFresh(sql, {
          instanceId: row.instanceId,
          clientId: row.clientId,
          staleMs: DISCOVERY_STALE_MS,
        }),
      ),
    getLagP99Ms: () => 0,
    getCap: () => currentSessionCap,
    getCurrentSessions: () => registry.size,
    onCycleError: (err) => {
      logger.error({}, `discovery cycle failed: ${describeError(err)}`);
    },
    maxRows: maxScanRows,
  });

  async function readFleetGaugesForCache(): Promise<number> {
    const gauges = await readFleetGauges(pool);
    return readFleetCapacityHeadroom({
      redis: redisCtl,
      env,
      desiredOnlineCount: gauges.desiredOnlineCount,
    });
  }

  async function runOneDiscoveryCycle(): Promise<void> {
    waveConnectTracker.beginCycle();
    await discoveryLoop.runOneCycle();
    try {
      await publishWorkerCap({
        redis: redisCtl,
        env,
        workerId,
        cap: currentSessionCap,
      });
    } catch (err) {
      logger.warn({}, `fleet worker-cap publish failed: ${describeError(err)}`);
    }
    try {
      const gauges = await readFleetGaugesForCache();
      setCachedFleetHeadroom(gauges);
    } catch (err) {
      // Fail-safe (core invariant 2): a failed headroom refresh leaves the
      // PREVIOUS cached value in place (or null, before the first success) -
      // never treated as "headroom just became 0" by clobbering a real prior
      // reading with an error-driven guess.
      logger.warn({}, `fleet headroom cache refresh failed: ${describeError(err)}`);
    }
  }

  return { discoveryLoop, startDiscovered, runOneDiscoveryCycle };
}
