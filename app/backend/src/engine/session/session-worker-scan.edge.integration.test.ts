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
 * session-worker-scan.edge.integration.test.ts - E3 edge-case pass (P08
 * session-qr-linking, timing/robustness updated P09 U6 step 9). Two
 * scan-loop edge cases `session-worker-discovery.integration.test.ts`'s
 * cases do not reach: (1) a discovery row for an instance ALREADY present in
 * the registry must never start a second runner (the
 * `registry.has(row.instanceId)` skip in `runOneScanIteration`), and (2) a
 * registry entry whose underlying `whatsapp_instances` row was HARD-DELETED
 * mid-flight (simulated here via a direct DELETE against the test pool,
 * bypassing the app's own soft-delete-only path - `wp_app` itself has no
 * DELETE grant, but nothing stops an operator/migration from truncating a
 * row directly) - `teardownIfNoLongerEligible`'s `readLinkStatus` returns
 * `null` for a row that no longer exists, and the scan must park it (no
 * crash, no unhandled rejection).
 *
 * DEVIATION (P09 U6 step 9): same as `session-worker-discovery.integration
 * .test.ts` - `wp_lease_scan_unowned`'s broader predicate now also discovers
 * the shared dev database's pre-existing `db/seeds/queue-explain-fixture.sql`
 * rows, so both cases here use `registry.has(instanceId)` (never an exact
 * `registrySize()`), a generous `maxScanRows`, and `COMPRESSED_TIMING`
 * (`takeoverGraceMs: 0`) so incidental fixture-row grabs never blow the test
 * budget.
 */

const ENV = 'test';
const WORKER_ID = 'worker-session-worker-scan-edge-test';
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

function makeFakeSocketFactory(fakeSockets: FakeSock[]): () => FakeSock {
  return vi.fn(() => {
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
    fakeSockets.push(sock);
    return sock;
  });
}

describe('createSessionWorker scan edge cases', () => {
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

  it('a_scan_row_for_an_instance_already_in_the_registry_never_starts_a_second_runner', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-scan-edge-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [clientId, 'Scan Edge Probe', `sw-scan-edge-probe-${clientId}`],
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

    const fakeSockets: FakeSock[] = [];
    const socketFactory = makeFakeSocketFactory(fakeSockets);
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
      maxScanRows: 200,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    // First iteration: starts the runner for real - registry now holds this
    // instance (never an exact registrySize() - see the file-level
    // DEVIATION doc comment).
    await worker.runOneScanIteration();
    expect(worker.registry.has(instanceId)).toBe(true);
    const socketFactoryCallsAfterFirst = (socketFactory as ReturnType<typeof vi.fn>).mock.calls
      .length;

    // Second iteration: the SAME discovery row is still eligible
    // (desired_state still 'online', link_state still 'pairing') - since the
    // instance is ALREADY in the registry, this must be a no-op skip for
    // THIS instance specifically: no second socketFactory call for it (the
    // registry handle instance is unchanged - same object reference).
    const handleAfterFirst = worker.registry.get(instanceId);
    await worker.runOneScanIteration();
    expect(worker.registry.has(instanceId)).toBe(true);
    expect(worker.registry.get(instanceId)).toBe(handleAfterFirst);
    // The discovery loop's own `grab` short-circuits to `true` without
    // calling `startDiscovered`/`socketFactory` again for an id already in
    // the registry (session-worker-composition.ts's `grab` closure) -
    // incidental fixture rows may still add MORE calls, so this asserts "no
    // additional call happened for THIS instance" via the handle-identity
    // check above, not a call-count bound (which fixture noise would break).
    void socketFactoryCallsAfterFirst;

    await worker.shutdown();
  }, 30_000);

  it('a_registry_entry_whose_row_was_hard_deleted_mid_flight_is_torn_down_without_crashing', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-scan-edge-test',
    });
    redis = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [clientId, 'Scan Edge Hard Delete Probe', `sw-scan-edge-hard-delete-${clientId}`],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, health_state, link_state, desired_state, session_epoch)
       VALUES ($1, $2, 'probe', 'never_linked', 'unlinked', 'online', 0)`,
      [instanceId, clientId],
    );
    // Deliberately NOT pushed to probeClientIds - the row is hard-deleted by
    // this test itself before cleanup would run, and the client row is
    // cleaned up manually at the end regardless of outcome.

    const ctx = ctxFor(pool, clientId);
    await beginPairingIntent(ctx, instanceId);

    const fakeSockets: FakeSock[] = [];
    const socketFactory = makeFakeSocketFactory(fakeSockets);
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
      maxScanRows: 200,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    try {
      await worker.runOneScanIteration();
      expect(worker.registry.has(instanceId)).toBe(true);

      // Hard-delete the row directly against the test's own superuser pool -
      // bypassing the app's soft-delete-only path entirely (wp_app itself
      // has no DELETE grant - this simulates an operator-level row loss, not
      // a code path the app can reach on its own).
      await pool.query('DELETE FROM instance_lease_state WHERE instance_id = $1', [instanceId]);
      await pool.query('DELETE FROM whatsapp_instances WHERE id = $1', [instanceId]);

      // The next scan iteration must observe readLinkStatus() returning
      // null for this instance (row gone) and tear it down cleanly - no
      // thrown error, no unhandled rejection, registry no longer holds it.
      await expect(worker.runOneScanIteration()).resolves.toBeUndefined();
      expect(worker.registry.has(instanceId)).toBe(false);
    } finally {
      await worker.shutdown();
      await pool.query('DELETE FROM audit_logs WHERE client_id = $1', [clientId]);
      await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
  }, 30_000);
});
