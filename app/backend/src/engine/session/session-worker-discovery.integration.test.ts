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
import { beginPairingIntent, setDesiredState } from '../../modules/instances/index.js';
import { createSessionWorker } from './session-worker-composition.js';
import type { FakeSock } from './runner-test-support.js';

/**
 * session-worker-discovery.integration.test.ts (P09 U6 step 9 - RENAMED from
 * `session-worker-scan.integration.test.ts`, P08 U6b PART 1) - migrates that
 * file's two cases onto the discovery-driven `runOneScanIteration` (the P08
 * narrow `bootstrapScan`/`wp_session_bootstrap_scan` query is retired; the
 * fleet-wide `createDiscoveryLoop` - backed by the already-registered
 * `wp_lease_scan_unowned` via `db/queries/discover-instances.sql` - now drives
 * the "start newly-discovered instances" half of `runOneScanIteration`, with
 * `sweepTeardowns` untouched for the "park instances gone offline/deleted"
 * half). No behavioral change to either case: `wp_lease_scan_unowned`'s own
 * eligibility predicate (`desired_state = 'online'`, `link_state IN
 * ('linked', 'pairing')`, `health_state <> 'logged_out'`, unowned/stale lease)
 * is a superset-compatible match for what `wp_session_bootstrap_scan` picked
 * up in these fixtures (both seed via `beginPairingIntent`, giving
 * `link_state = 'pairing'`) - only the `scan`/`BootstrapScanRow` test-only
 * shim is removed, since `createSessionWorker` no longer takes an injected
 * scan function at all.
 *
 * Case mapping (old -> new, both UNCHANGED assertions):
 *   - `park_ends_the_socket_and_never_logs_out` -> same name, same body,
 *     minus the `scan` deps field (discovery runs internally now).
 *   - `a_teardown_sweep_over_two_held_instances_across_two_clients_tears_down_only_the_parked_one`
 *     -> same name, same body, same removal.
 *
 * DEVIATION (P09 U6 step 9): the broader `wp_lease_scan_unowned` discovery
 * predicate (`link_state IN ('linked', 'pairing')`, vs the retired scan's
 * `pairing`-only match) now ALSO discovers this shared dev database's
 * pre-existing `db/seeds/queue-explain-fixture.sql` rows (50+
 * `desired_state='online'`/`link_state='linked'` fixture instances, seeded
 * for an unrelated suite's EXPLAIN-plan tests, never cleaned up). Each is a
 * REAL, valid lease-acquire target from the discovery loop's point of view,
 * so `runOneScanIteration` legitimately tries to grab them too - at the
 * real, uncompressed `TIMING.takeoverGraceMs` (15s) that is enough fixture
 * rows to blow through any test timeout. `timing: COMPRESSED_TIMING` below
 * (the same compressed-timing seam `session-worker-two-workers.c2
 * .integration.test.ts` already uses directly against `LeaseManager`, now
 * exposed on `CreateSessionWorkerDeps` itself) keeps each grab near-instant
 * regardless of how many incidental fixture rows a cycle also picks up.
 */

const ENV = 'test';
const WORKER_ID = 'worker-session-worker-discovery-test';
/** See the file-level DEVIATION doc comment above. */
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

describe('createSessionWorker - discovery loop drives start/teardown', () => {
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

  it('park_ends_the_socket_and_never_logs_out', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-discovery-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [clientId, 'Session Worker Discovery Probe', `sw-discovery-probe-${clientId}`],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, health_state, link_state, desired_state, session_epoch)
       VALUES ($1, $2, 'probe', 'never_linked', 'unlinked', 'online', 0)`,
      [instanceId, clientId],
    );
    probeClientIds.push(clientId);

    // Seeds the pairing intent so `wp_lease_scan_unowned` (via the discovery
    // loop) picks this instance up (desired_state = 'online', link_state =
    // 'pairing').
    const ctx = ctxFor(pool, clientId);
    await beginPairingIntent(ctx, instanceId);

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
      };
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
      // A generous bound (not the file's original 10): `wp_lease_scan_unowned`
      // orders by random() and LIMITs - a small maxRows risks this test's OWN
      // seeded row losing the random draw against the shared dev database's
      // pre-existing fixture rows (see the file-level DEVIATION doc comment).
      // 200 comfortably covers today's fixture population plus this test's
      // own row(s) every run.
      maxScanRows: 200,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    await worker.runOneScanIteration();

    // Never an exact registrySize() - the discovery loop may legitimately
    // also grab unrelated pre-seeded fixture rows in the same cycle (see the
    // file-level DEVIATION doc comment). This test only asserts its OWN
    // instance is present.
    expect(worker.registry.has(instanceId)).toBe(true);
    expect(worker.registry.get(instanceId)).toBeDefined();

    // Flip desired_state to 'offline' - a second scan iteration must tear
    // down (park) this instance: lease released, registry no longer holds
    // it (never through `sock.logout()` - the static `logout-call-sites
    // .test.ts` scan proves no `.logout(` call site exists anywhere this
    // teardown path can reach).
    await setDesiredState(ctx, instanceId, 'offline');

    await worker.runOneScanIteration();

    expect(worker.registry.has(instanceId)).toBe(false);

    const leaseRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseRow.rows[0]?.released_at).not.toBeNull();

    await worker.shutdown();
  }, 30_000);

  it('a_teardown_sweep_over_two_held_instances_across_two_clients_tears_down_only_the_parked_one', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-discovery-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientIdA = randomUUID();
    const clientIdB = randomUUID();
    const instanceIdHeld = randomUUID();
    const instanceIdParked = randomUUID();

    for (const [clientId, instanceId] of [
      [clientIdA, instanceIdHeld],
      [clientIdB, instanceIdParked],
    ] as const) {
      await pool.query(
        `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
        [clientId, 'Sweep Probe', `sw-sweep-probe-${clientId}`],
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
    }

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
      };
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
      // A generous bound (not the file's original 10): `wp_lease_scan_unowned`
      // orders by random() and LIMITs - a small maxRows risks this test's OWN
      // seeded row losing the random draw against the shared dev database's
      // pre-existing fixture rows (see the file-level DEVIATION doc comment).
      // 200 comfortably covers today's fixture population plus this test's
      // own row(s) every run.
      maxScanRows: 200,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    // Discovers and starts runners for BOTH instances (2,000-target scale:
    // one worker legitimately holds sessions across many clients) - never an
    // exact registrySize() (see the file-level DEVIATION doc comment: the
    // discovery loop may also grab unrelated pre-seeded fixture rows from
    // the shared dev database in the same cycle).
    await worker.runOneScanIteration();
    expect(worker.registry.has(instanceIdHeld)).toBe(true);
    expect(worker.registry.has(instanceIdParked)).toBe(true);

    // Park ONE of the two via the normal soft path - the OTHER stays online.
    const ctxB = ctxFor(pool, clientIdB);
    await setDesiredState(ctxB, instanceIdParked, 'offline');

    await worker.runOneScanIteration();

    // Exactly one teardown (the parked instance) - the held one stays.
    // NOTE (C1 re-verify note): this test pins the sweep's teardown EFFECT
    // only. The per-client-batching claim cannot be observed from a
    // `pool.query` spy (the sweep runs on `tenantDb.withTenant`'s own
    // checked-out connections) and is instead pinned by the SQL file's
    // client_id predicate plus the dedicated wp_app-role integration test
    // (session-worker-sweep.wp-app-role.integration.test.ts).
    expect(worker.registry.has(instanceIdHeld)).toBe(true);
    expect(worker.registry.has(instanceIdParked)).toBe(false);

    await worker.shutdown();
  }, 60_000);
});
