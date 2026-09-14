import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupProbeClients,
  ctxFor,
} from '../../modules/instances/__tests__/instances-test-helpers.js';
import { writeTempSessionKeyRing } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { beginPairingIntent } from '../../modules/instances/index.js';
import { createSessionWorker } from './session-worker-composition.js';
import type { FakeSock } from './runner-test-support.js';

/**
 * session-worker-composition.fence-liveness.integration.test.ts (FIX BATCH A,
 * A1) - the composition-level test the reviewer prescribed: builds a runner
 * THROUGH `createSessionWorker`'s real `runOneScanIteration` (which calls the
 * real `buildSessionRunnerFor` factory internally, not a test-only shortcut),
 * with a fake socket but REAL pg/redis fixtures, drives qr -> open, and
 * asserts the row actually reaches `link_state='linked'` /
 * `health_state='connected'`.
 *
 * This is the regression guard for the A1 bug: `buildSessionRunnerFor` used
 * to capture `currentFence(instanceId)` EAGERLY at composition time - before
 * `runner.start()` ever calls `leaseManager.acquire()` - so the instances
 * adapter's `markLinkedConnected`/`runLoggedOutFlow` calls were permanently
 * bound to whatever fence existed (typically `0n`, since no lease was held
 * yet) instead of the fence the lease manager actually acquires. Every
 * production write through that adapter would then fail its fence-guarded
 * `WHERE current_fence = $fence` predicate silently forever. Only a test that
 * goes through the REAL composition wiring (not `runner-test-support.ts`'s
 * `buildRunner`, which passes a real fence value directly) can catch this.
 *
 * FIX (2026-09-01, fifth flaky-real-infra-class instance): this test used to
 * drive discovery through `worker.runOneScanIteration()` - which runs the
 * REAL `wp_lease_scan_unowned` scan, `ORDER BY random() LIMIT
 * maxScanRows` - wrapped in a 20s wall-clock retry loop. The shared dev
 * database permanently carries 50+ eligible fixture rows from
 * `db/seeds/queue-explain-fixture.sql` (seeded for an unrelated EXPLAIN-plan
 * suite, never cleaned up - see `session-worker-discovery.integration.test.ts`'s
 * own DEVIATION doc comment) plus other suites' transient probe rows, so
 * `maxScanRows: 1` (required below for the socket-correlation heuristic)
 * made this test's own row win the random draw roughly 1-in-50+ per cycle -
 * a real geometric-distribution race, not a "flaky under load" symptom: it
 * failed standalone too. Per core-invariants.md's ambient-state rule, a
 * bigger timeout only hides the race, it does not remove it.
 *
 * The fix removes the random draw from this test's scope entirely
 * (core-invariants.md option: "if the property under test genuinely does
 * not need discovery-by-scan, drive the runner through the real factory
 * directly"): `createSessionWorker` now exposes `startDiscoveredForTest`,
 * which calls the EXACT SAME `buildSessionRunnerFor` + `runner.start()` path
 * `runOneDiscoveryCycle`'s `grab()` calls per scanned row - the real
 * composition wiring this test's name and describe block are about - minus
 * the scan's `ORDER BY random()` row selection. This test supplies
 * `instanceId`/`clientId` directly, so discovery is deterministic: one call,
 * one guaranteed registration, no retry loop, no shared-dev-database
 * competition.
 *
 * The socket under test is still correlated by REGISTRATION ORDER (the
 * registry handle for `instanceId` is set synchronously immediately before
 * `socketFactory` is invoked for it - `runner.ts`'s own `registry.set(...)`
 * then `buildAndWireSocket()` order) - safe here because exactly one
 * `startDiscoveredForTest` call is ever in flight, so `socketFactory` is
 * called at most once total, never racing another instance's deferred build.
 */

const ENV = 'test';
const WORKER_ID = 'worker-fence-liveness-test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 30_000,
  heartbeatMs: 10_000,
  takeoverGraceMs: 0,
  watchdogMs: 15_000,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 2000,
  pgConnectTimeoutMs: 3000,
  pgStatementTimeoutMs: 5000,
} as const;

describe('createSessionWorker composition - fence read must be live, not frozen at build time', () => {
  let pool: ReturnType<typeof createPool>;
  let redis: ReturnType<typeof createRedis>;
  let redisSig: ReturnType<typeof createRedis>;
  let redisCache: ReturnType<typeof createRedis>;
  const probeClientIds: string[] = [];

  afterEach(async () => {
    if (probeClientIds.length > 0) {
      await cleanupProbeClients(pool, probeClientIds);
      probeClientIds.length = 0;
    }
  });

  afterAll(async () => {
    await pool?.end();
    redis?.disconnect();
    redisSig?.disconnect();
    redisCache?.disconnect();
  });

  it('a_runner_built_through_the_real_factory_persists_linked_connected_on_open', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-fence-liveness-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [clientId, 'Fence Liveness Probe', `sw-fence-liveness-probe-${clientId}`],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, health_state, link_state, desired_state, session_epoch)
       VALUES ($1, $2, 'probe', 'never_linked', 'unlinked', 'online', 0)`,
      [instanceId, clientId],
    );
    probeClientIds.push(clientId);

    const ctx = ctxFor(pool, clientId);
    await beginPairingIntent(ctx, instanceId);

    // Exactly one `startDiscoveredForTest` call is ever made below, for this
    // test's own `instanceId` only, so `socketFactory` is called at most
    // once total - no elimination heuristic against concurrently-registered
    // instances is needed (contrast the old scan-driven version of this
    // test, which had to disambiguate against incidentally-grabbed fixture
    // rows). `socketReady` is the INJECTED settle signal for the deferred
    // `buildAndWireSocket()` call (`runner.ts`'s fire-and-forget
    // `runDeferredSocketOpen` chain - see runner-deferred-open.ts, not
    // observable via any returned promise) - resolved synchronously, inside
    // `socketFactory`'s own body, the instant it is invoked. Awaiting this
    // promise below replaces polling `setTimeout` entirely.
    let resolveSocketReady!: (sock: FakeSock) => void;
    const socketReady = new Promise<FakeSock>((resolve) => {
      resolveSocketReady = resolve;
    });
    const socketFactory = vi.fn(() => {
      const handlers = new Map<string, (u: unknown) => unknown>();
      const sock: FakeSock = {
        ev: {
          on(ev: string, cb: (u: unknown) => void) {
            handlers.set(ev, cb);
          },
          async emit(ev: string, payload: unknown) {
            const cb = handlers.get(ev);
            if (cb) await cb(payload);
          },
        },
        end: vi.fn(),
        user: { id: '15550001234:1@s.whatsapp.net' },
      };
      resolveSocketReady(sock);
      return sock;
    });

    const keyProvider = new FileKeyProvider({
      ringPath: writeTempSessionKeyRing(),
      mountedPurposes: ['session'],
    });

    const worker = createSessionWorker({
      env: ENV,
      workerId: WORKER_ID,
      pool,
      tenantDb: createTenantDb(pool),
      workerDb: createWorkerDb(pool),
      redisCtl: redis,
      redisSig,
      redisCache,
      keyProvider,
      socketFactory,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    // Deterministic discovery: `startDiscoveredForTest` drives THIS test's
    // own `(instanceId, clientId)` directly through the real
    // `buildSessionRunnerFor` + `runner.start()` composition path - the
    // exact call `runOneDiscoveryCycle`'s scan-driven `grab()` makes per
    // row - with no `ORDER BY random()` row selection and no shared-dev-
    // database competition (see the file-level FIX doc comment above). One
    // call, one guaranteed registration.
    const acquired = await worker.startDiscoveredForTest(instanceId, clientId);
    expect(acquired).toBe(true);
    expect(worker.registry.has(instanceId)).toBe(true);

    // P09 fleet-recovery FIX: the socket build is deferred behind the
    // connect-gate wait (per-worker AND real fleet-wide Redis bucket - a
    // real Redis I/O round trip, not just a microtask hop) via `runner.ts`'s
    // fire-and-forget `runDeferredSocketOpen` chain, so `registry.has()`
    // going true does not imply the socket already exists. `socketReady`
    // (resolved synchronously inside `socketFactory`'s own body - see above)
    // is the injected settle signal for that chain: awaiting it is
    // deterministic, unlike polling on a timer.
    const sock = await socketReady;
    await sock.ev.emit('connection.update', { qr: 'qr-fence-liveness' });
    await sock.ev.emit('connection.update', { connection: 'open' });

    const row = await pool.query<{ link_state: string; health_state: string }>(
      'SELECT link_state, health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.link_state).toBe('linked');
    expect(row.rows[0]?.health_state).toBe('connected');

    await worker.shutdown();
  }, 30_000);
});
