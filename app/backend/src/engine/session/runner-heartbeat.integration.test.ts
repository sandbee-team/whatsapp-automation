import { randomUUID } from 'node:crypto';
import { TIMING } from '@wp/domain';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseManager } from '../lease/lease-manager.js';
import { LeaseHeartbeat } from '../lease/heartbeat.js';
import { createLeaseRedis } from '../lease/lease-redis.js';
import { createSessionRegistry, createSessionOwner } from './registry.js';
import { createPairingController } from './pairing.js';
import { createSessionRunner } from './runner.js';
import { buildInstancesAdapter } from './runner-test-instances-adapter.js';
import { resolveDisconnect } from '../../provider/baileys/disconnect-map.js';
import { toFsmRow } from './to-fsm-row.js';
import * as instancesRepo from '../../modules/instances/repo.js';
import {
  ctxFor,
  seedTenant,
  cleanupProbeClients,
} from '../../modules/instances/__tests__/instances-test-helpers.js';
import { makeFakeSock, makeClock, makeFakeTimerScheduler } from './runner-test-support.js';
import type { InstanceServiceDeps } from '../../modules/instances/service.js';

/**
 * runner-heartbeat.integration.test.ts (P08 U5b, TEST 3) - proves a pairing
 * window (5 minutes) survives the 30s lease TTL through renewal: a REAL
 * `LeaseManager` (real `lease-redis` over real Redis + real Postgres mint)
 * plus a REAL `LeaseHeartbeat`, constructed with a BOUNDED pool
 * (`statementTimeoutMs: TIMING.pgStatementTimeoutMs`,
 * `connectionTimeoutMillis: TIMING.pgConnectTimeoutMs` - mirrors P06's
 * heartbeat.integration.test.ts's own bounded-pool pattern) and a real
 * `WorkerDb`. `Runner.start` runs against a fake socket that emits ONE qr and
 * then stays idle; `heartbeat.tick()` is called manually 4+ times while
 * advancing PAST `leaseTtlMs` (30s) on the injected clocks.
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

const ENV = 'test';
const workerId = 'worker-runner-heartbeat-test';

let pool: TestPool;
let redis: TestRedis;
let probeClientIds: string[] = [];
let probeKeys: string[] = [];

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  if (probeClientIds.length > 0) {
    await cleanupProbeClients(pool, probeClientIds);
    probeClientIds = [];
  }
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe('runner lease renewal across the pairing window', () => {
  it('runner_lease_renews_across_the_pairing_window', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'runner-heartbeat-test',
      statementTimeoutMs: TIMING.pgStatementTimeoutMs,
      connectionTimeoutMillis: TIMING.pgConnectTimeoutMs,
    });
    redis = createRedis(resolveRedisUrl());

    const { clientId, instanceId } = await seedTenant(pool, {
      healthState: 'never_linked',
      linkState: 'unlinked',
    });
    probeClientIds.push(clientId);
    probeKeys.push(tenantKey(ENV, clientId, 'lease', 'i', instanceId));
    // A real pairing_started_at (P08 FIX BATCH A, A7: a null one is now
    // treated as an EXPIRED window, not fail-open) - this test drives a real
    // QR event through the pairing controller and needs it to stay within
    // budget, matching what beginPairingIntent would set in production.
    await pool.query('UPDATE whatsapp_instances SET pairing_started_at = now() WHERE id = $1', [
      instanceId,
    ]);

    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const workerDb = createWorkerDb(pool);
    const registry = createSessionRegistry();
    const sessionOwner = createSessionOwner(registry);

    const leaseManager = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner,
      workerId,
      env: ENV,
    });

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql: workerDb,
      sessionOwner,
      workerId,
      env: ENV,
    });

    const clock = makeClock(0);
    const scheduler = makeFakeTimerScheduler();
    const sock = makeFakeSock();

    const ctx = ctxFor(pool, clientId);
    const auditSql = pool as unknown as InstanceServiceDeps['auditSql'];
    const serviceDeps: InstanceServiceDeps = { ctx, auditSql };

    let instanceIdHolder = '';
    const currentInstanceId = () => instanceIdHolder;

    const pairing = createPairingController({
      repoCtx: {
        incrementQrAttempts: async () => {
          const result = await instancesRepo.incrementQrAttempts(ctx, {
            instanceId: currentInstanceId(),
            fence: 1n,
            workerId,
          });
          return { qr_attempts: result.qrAttempts, pairing_started_at: result.pairingStartedAt };
        },
        markPairingExpired: () =>
          instancesRepo.markPairingExpired(ctx, {
            instanceId: currentInstanceId(),
            fence: 1n,
            workerId,
          }),
      },
      publish: () => undefined,
      clock,
      clientId,
      instanceId,
    });

    const instances = buildInstancesAdapter({
      ctx,
      serviceDeps,
      currentFence: () => 1n,
      workerId,
      currentInstanceId,
    });

    const authStoreFake = {
      loadCreds: vi.fn().mockResolvedValue(null),
      saveCreds: vi.fn().mockResolvedValue({ credVersion: 1n }),
      getKeys: vi.fn(),
      setKeys: vi.fn(),
      purge: vi.fn().mockResolvedValue({ purged: true }),
      asSignalKeyStore: vi.fn(),
    };
    const buildAuthStore = vi.fn(() => ({
      store: authStoreFake,
      signalKeyStore: {},
    }));

    const runner = createSessionRunner({
      leaseManager,
      heartbeat,
      buildAuthStore,
      socketFactory: vi.fn(() => sock),
      instances,
      pairing,
      connectGate: { take: vi.fn().mockResolvedValue(undefined) },
      publish: () => undefined,
      resolveDisconnect,
      toFsmRow,
      reconnect: {
        nextDelayMs: vi.fn().mockReturnValue(1234),
        shouldGiveUp: vi.fn().mockReturnValue(false),
        onOpen: vi.fn().mockReturnValue(0),
      },
      rng: { random: () => 0.5 },
      clock,
      setTimeoutFn: scheduler.setTimeoutFn,
      clearTimeoutFn: (handle: unknown) => scheduler.clearTimeoutFn(handle as number),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      workerId,
      env: ENV,
      expectedTakeoverCheck: vi.fn().mockResolvedValue(false),
      registry,
      sessionOwner,
    });

    const startResult = await runner.start({ instanceId, clientId, method: 'qr' });
    expect(startResult).not.toBe('not_acquired');
    if (startResult === 'not_acquired') return;
    instanceIdHolder = instanceId;

    // P09 fleet-recovery FIX: this is a first-ever mint (no prior
    // `instance_lease_state` row), so `LeaseManager.acquire`'s grace-skip
    // does NOT apply (`prevReleasedAt`/`prevOwnerWorkerId` both null -
    // never-owned still pays the full `takeoverGraceMs`, see lease-
    // manager.ts's own step 4 doc comment) - `acquire()` no longer awaits
    // that grace inline, so `start()` returns with a real, uncompressed
    // `TIMING.takeoverGraceMs` (15s) grace timer scheduled on THIS fake
    // scheduler instead. Firing it here (deterministic, no real 15s wait)
    // is what lets the deferred `buildAndWireSocket()` call actually run
    // before the QR emit below.
    await scheduler.fireAll();

    // Runner emits ONE qr and then stays idle.
    await sock.ev.emit('connection.update', { qr: `qr-${randomUUID()}` });

    heartbeat.add({ instanceId, clientId, fence: 1n, workerId, graceMs: 0 });

    const leaseKey = tenantKey(ENV, clientId, 'lease', 'i', instanceId);

    // Drive heartbeat.tick() manually 4+ times, advancing PAST leaseTtlMs
    // (30s) on the injected clock each time - the pairing window (5 min)
    // survives the 30s lease TTL purely through renewal.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(TIMING.leaseTtlMs + 1_000);
      await heartbeat.tick();
    }

    // The Redis lease key still exists with our worker value.
    const rawValue = await redis.get(leaseKey);
    expect(rawValue).not.toBeNull();
    expect(rawValue).toContain(workerId);

    // instance_lease_state.current_fence unchanged, lease not lost.
    const row = await pool.query<{ current_fence: string; released_at: Date | null }>(
      'SELECT current_fence, released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(row.rows[0]?.current_fence).toBe('1');
    expect(row.rows[0]?.released_at).toBeNull();
    expect(heartbeat.held().some((l) => l.instanceId === instanceId)).toBe(true);

    // After runner stop() (teardownWithRelease), the lease is released cleanly.
    const handle = registry.get(instanceId);
    expect(handle).toBeDefined();
    await handle?.teardownWithRelease();

    const afterStop = await redis.get(leaseKey);
    expect(afterStop).toBeNull();

    const releasedRow = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(releasedRow.rows[0]?.released_at).not.toBeNull();
  }, 30_000);
});
