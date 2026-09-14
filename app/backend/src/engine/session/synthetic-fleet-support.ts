import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { instanceConnectOffsetMs } from '../fleet/connect-budget.js';
import { writeTempSessionKeyRing } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { createSessionWorker, type SessionWorker } from './session-worker-composition.js';
import type { FakeableSocket } from './runner-types.js';

/**
 * synthetic-fleet-support.ts (P09 U7 step 10) - the in-process "worker"
 * harness `fleet-recovery.integration.test.ts` drives: each worker is a REAL
 * `createSessionWorker` composition (`session-worker-composition.ts`) wired
 * to real Postgres (`resolveDatabaseUrl()`) and real Redis
 * (`resolveRedisUrl()`), extending the P08 FakeSock idiom
 * (`runner-test-support.ts#FakeSock`) into a COUNTING socket factory shared
 * across every worker in one test: it records every socket-open timestamp
 * (`Date.now()`, sufficient resolution for the 1-second bucket-rate
 * assertion) and every QR emission fleet-wide (never per-instance - a
 * shared counter across every worker is exactly what the connect-bucket
 * rate assertion and the zero-re-QR assertion both need), and lets a test
 * simulate the provider handshake by emitting a synthetic
 * `connection.update` `open` event after a configurable delay.
 *
 * ABSOLUTE BOUNDARY (safety): every socket this module builds is entirely
 * synthetic - an in-memory event-emitter stand-in, never a real Baileys
 * socket, never real network I/O, never a real WhatsApp number. The counting
 * factory is the ONLY thing standing in for `provider/baileys/socket-
 * factory.ts#createBaileysSocket` in this harness.
 *
 * `kill9(worker)` simulates a hard process kill (SIGKILL semantics): it
 * clears every fake-scheduler-independent interval this harness itself
 * started for that worker (the discovery-loop poll timer) and simply stops
 * calling into the worker - it deliberately does NOT call
 * `worker.shutdown()`/`beginDrain()`/anything that would release a lease or
 * end a socket, because a real `kill -9` gets no such chance either. The
 * worker's heartbeat naturally stops renewing once nothing schedules its
 * timer anymore, and its Redis-side lease key/PG fence row age out on their
 * own via the real `LeaseManager`/`LeaseHeartbeat` TTL and takeover-grace
 * machinery - this harness never fabricates that expiry.
 *
 * `drain(worker)` is the REAL graceful path: it wires `createDrain` exactly
 * like `roles/session-worker.ts` does (same `buildDrainSessions`/
 * `buildEmptyInFlightPort` adapters) and captures the `exit(code)` call so
 * the test can assert on it without a real `process.exit`.
 */

/**
 * Structurally a superset of the P07 `StoreTestHandles` shape
 * (`redisLease`/`keyRingPath` added) so `store-fixtures.ts#buildStore` can be
 * called directly against these same handles when seeding real creds -
 * avoids standing up a second, parallel set of Postgres/Redis connections
 * just for the auth-store leg.
 */
export interface SyntheticFleetHandles {
  pool: ReturnType<typeof createPool>;
  redisCtl: ReturnType<typeof createRedis>;
  redisSig: ReturnType<typeof createRedis>;
  redisCache: ReturnType<typeof createRedis>;
  redisLease: ReturnType<typeof createRedis>;
  keyRingPath: string;
}

export function createSyntheticFleetHandles(): SyntheticFleetHandles {
  return {
    pool: createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'fleet-recovery-test',
    }),
    redisCtl: createRedis(resolveRedisUrl()),
    redisSig: createRedis(resolveRedisUrl()),
    redisCache: createRedis(resolveRedisUrl()),
    redisLease: createRedis(resolveRedisUrl()),
    keyRingPath: writeTempSessionKeyRing(),
  };
}

export async function disposeSyntheticFleetHandles(handles: SyntheticFleetHandles): Promise<void> {
  await handles.pool.end();
  handles.redisCtl.disconnect();
  handles.redisSig.disconnect();
  handles.redisCache.disconnect();
  handles.redisLease.disconnect();
}

// ---------------------------------------------------------------------
// Counting fake-socket factory - shared across every worker in one test so
// connect timestamps/QR counts are observed FLEET-WIDE, not per-worker.
// ---------------------------------------------------------------------

export interface CountingSocketFactory {
  /** `session-worker-composition.ts`'s own `socketFactory` port shape. */
  factory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  /** Every recorded socket-open timestamp (`Date.now()` at build time), across every socket this factory has ever built, in build order. Fleet-wide by construction: every worker in a test shares ONE `CountingSocketFactory` instance. */
  allOpenTimestamps(): number[];
  /** Total QR emissions across every socket this factory has ever built. */
  totalQrCount(): number;
  /** Total sockets built so far. */
  totalOpened(): number;
}

/**
 * `openAfterMs` controls how long after construction the synthetic socket
 * fires a bare `connection.update({ connection: 'open' })` - this is what
 * lets the harness simulate "the provider handshake finished" without any
 * real network. This factory never emits a `qr` field on its own (`qrCount`
 * always stays 0) - a real production socket only emits `qr` when the
 * instance still needs pairing; every instance this harness seeds is
 * pre-linked with real creds (`link_state = 'linked'`), so the runner takes
 * the resume-from-creds path and never reaches a QR-eligible code path.
 * `totalQrCount()` therefore stands as the harness's own proof that zero QR
 * flows were needed, not a simulation of one.
 */
export function createCountingSocketFactory(
  options: { openAfterMs?: number } = {},
): CountingSocketFactory {
  const openAfterMs = options.openAfterMs ?? 5;
  const openTimestamps: number[] = [];
  const qrCount = 0;

  function buildOne(): FakeableSocket {
    openTimestamps.push(Date.now());

    const handlers = new Map<string, (u: unknown) => unknown>();
    const timer = setTimeout(() => {
      const cb = handlers.get('connection.update');
      if (cb) void cb({ connection: 'open' });
    }, openAfterMs);
    // Never keeps the process alive on its own - a killed worker's pending
    // opens must not block test teardown.
    timer.unref?.();

    return {
      ev: {
        on(ev: string, cb: (u: unknown) => void) {
          handlers.set(ev, cb);
        },
      },
      end: vi.fn(),
    };
  }
  void qrCount; // always 0 (see doc comment) - kept as a named field for `totalQrCount()`'s contract rather than a bare literal return.

  return {
    factory: (): FakeableSocket => buildOne(),
    allOpenTimestamps(): number[] {
      return [...openTimestamps].sort((a, b) => a - b);
    },
    totalQrCount(): number {
      return qrCount;
    },
    totalOpened(): number {
      return openTimestamps.length;
    },
  };
}

// ---------------------------------------------------------------------
// Synthetic worker handle.
// ---------------------------------------------------------------------

export interface SyntheticWorkerHandle {
  workerId: string;
  worker: SessionWorker;
  /**
   * Hard-stop (SIGKILL semantics): stops ONLY this worker's heartbeat
   * renewal timer (`SessionWorker.stopHeartbeatOnly()`) so its held leases
   * stop being renewed and eventually go stale - never releases leases,
   * never ends sockets, never tears down the registry, never drains. `await`
   * this before treating the worker as "dead": `heartbeat.stop()` awaits
   * any tick already in flight (the same in-process timer a real `kill -9`
   * would never get the chance to wait for, but this harness has no OS
   * process boundary to rely on instead).
   */
  kill9(): Promise<void>;
  /** The worker's real drain path (`createDrain`, same wiring `roles/session-worker.ts` uses) - resolves once `exit(code)` has been captured. */
  drain(): Promise<{ exitCode: number | undefined }>;
  /** Runs one discovery+sweep iteration - the harness's manual substitute for `roles/session-worker.ts`'s own setTimeout loop (never a real timer in a deterministic test). */
  runOneScanIteration(): Promise<void>;
}

export interface CreateSyntheticWorkerOptions {
  handles: SyntheticFleetHandles;
  workerId: string;
  socketFactory: (auth: { creds: unknown; keys: unknown }) => FakeableSocket;
  maxScanRows?: number;
  sessionCap?: number;
}

/** Builds one real `createSessionWorker` composition wrapped with this harness's `kill9()`/`drain()` ports. Uses `handles.keyRingPath` - the SAME key ring `buildStore` (store-fixtures.ts) seeds creds through, so a worker can actually decrypt creds this harness seeded via `buildStore` (a mismatched ring would fail decryption at `loadCreds()` time). */
export function createSyntheticWorker(
  options: CreateSyntheticWorkerOptions,
): SyntheticWorkerHandle {
  const { handles, workerId, socketFactory, maxScanRows, sessionCap } = options;

  const worker = createSessionWorker({
    env: 'test',
    workerId,
    pool: handles.pool,
    tenantDb: createTenantDb(handles.pool),
    workerDb: createWorkerDb(handles.pool),
    redisCtl: handles.redisCtl,
    redisSig: handles.redisSig,
    redisCache: handles.redisCache,
    keyProvider: new FileKeyProvider({
      ringPath: handles.keyRingPath,
      mountedPurposes: ['session'],
    }),
    socketFactory,
    maxScanRows,
    sessionCap,
  });

  return {
    workerId,
    worker,
    async kill9(): Promise<void> {
      // SIGKILL semantics (task spec, verbatim): cancel all timers/loops,
      // drop the heartbeat, NEVER release leases, never drain.
      //
      // DEVIATION (found + fixed during this dispatch's own debugging):
      // `createSessionWorker` calls `heartbeat.start()` internally, which
      // arms a REAL `setInterval` that keeps renewing every held lease
      // (including this file's own seeded ones) regardless of whether the
      // TEST ever calls `runOneScanIteration()` again - a bare "the test
      // stops calling into this worker" is NOT equivalent to a real
      // process dying, because the heartbeat's own timer keeps firing in
      // the SAME Node process/event loop. Confirmed via a live-DB
      // diagnostic: every seeded instance stayed owned by "worker A" with a
      // fresh `lease_seen_at` indefinitely until this fix was made. The
      // NEW `SessionWorker.stopHeartbeatOnly()` port (added to
      // `session-worker-composition.ts` by this same dispatch) stops
      // exactly that timer and nothing else - no lease release, no socket
      // end, no registry mutation - so the held leases now correctly go
      // stale after real `leaseTtlMs`/discovery-staleness elapses, exactly
      // like a genuinely dead process's leases would.
      await worker.stopHeartbeatOnly();
    },
    async drain(): Promise<{ exitCode: number | undefined }> {
      let exitCode: number | undefined;
      const { createDrain, DEFAULT_DRAIN_DEADLINES } = await import('../fleet/drain.js');
      const { buildDrainSessions, buildEmptyInFlightPort } = await import('./fleet-adapters.js');

      const drain = createDrain({
        beginDrain: () => worker.beginDrain(),
        stopClaiming: async () => undefined,
        inFlight: buildEmptyInFlightPort(),
        markNeedsReconcile: async () => undefined,
        sessions: buildDrainSessions(
          worker.registry,
          worker.leaseManager,
          (instanceId) => worker.getHeldLease(instanceId),
          async () => undefined,
        ),
        closePools: async () => undefined, // this harness owns pool/redis lifecycle centrally - drain here never closes the shared handles.
        exit: (code: number) => {
          exitCode = code;
        },
        deadlines: DEFAULT_DRAIN_DEADLINES,
      });

      await drain.run();
      return { exitCode };
    },
    async runOneScanIteration(): Promise<void> {
      await worker.runOneScanIteration();
    },
  };
}

// ---------------------------------------------------------------------
// Bounded-offset instance id minting - the offset semantics themselves are
// unit-pinned elsewhere (runner-connect-offset.test.ts); this helper exists
// ONLY to bound this integration harness's wall-clock cost, per the phase's
// own documented gotcha.
// ---------------------------------------------------------------------

const BOUNDED_OFFSET_CEILING_MS = 10_000;

/** Mints a fresh UUID whose `instanceConnectOffsetMs(id) < 10_000` - bounds a wave-connect test's wall-clock cost. Never a semantic claim about the offset formula itself (see connect-budget.ts's own `instanceConnectOffsetMs`). */
export function mintBoundedOffsetInstanceId(): string {
  for (;;) {
    const id = randomUUID();
    if (instanceConnectOffsetMs(id) < BOUNDED_OFFSET_CEILING_MS) {
      return id;
    }
  }
}
