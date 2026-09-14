import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, createWorkerDb, type TenantDb, type WorkerDb } from '@wp/db';
import { createRedis, resolveRedisUrl } from '../../../src/platform/redis.js';
import { resolveDatabaseUrl } from '../../../src/platform/db/db-url.js';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import {
  createSessionWorker,
  type SessionWorker,
} from '../../../src/engine/session/session-worker-composition.js';
import { createCountingSocketFactory } from '../../../src/engine/session/synthetic-fleet-support.js';
import {
  writeTempSessionKeyRing,
  buildStore,
} from '../../../src/provider/baileys/auth-state/__tests__/store-fixtures.js';
import { FenceConflictError } from '../../../src/provider/baileys/auth-state/types.js';
import { tenantKey } from '../../../src/platform/redis/keys.js';
import {
  buildOutageGatedBufferWithLiveVersion,
  cleanupOutageProbes,
  createFailingPoolProxy,
  jobStatusesFor,
  sendAttemptsCountFor,
  seedOutageInstance,
  waitUntil,
  type OutageSwitch,
} from './postgres-outage-workload.js';

/**
 * postgres-outage.integration.test.ts (P26 U6a, step 6 chaos: Postgres
 * outage) - the failure-matrix row "Postgres down" at worker-composition
 * level: a Postgres availability failure buffers creds saves (bounded, max
 * 8, newest-wins) and keeps sockets up while sends stop; ONLY a fence
 * conflict self-fences (ADR 0018 S4, scope-delta #12).
 */

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 100,
  watchdogMs: 2_000,
  sendTimeoutMs: 1_000,
  claimExpiryMs: 2_000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5_000,
  redisCommandTimeoutMs: 1_000,
} as const;

type RealPool = ReturnType<typeof createPool>;

let realPool: RealPool;
let redisCtl: ReturnType<typeof createRedis>;
let redisSig: ReturnType<typeof createRedis>;
let redisCache: ReturnType<typeof createRedis>;
let keyRingPath: string;
let clientIds: string[] = [];

beforeAll(() => {
  realPool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'postgres-outage-test',
  });
  redisCtl = createRedis(resolveRedisUrl());
  redisSig = createRedis(resolveRedisUrl());
  redisCache = createRedis(resolveRedisUrl());
  keyRingPath = writeTempSessionKeyRing();
});

afterAll(async () => {
  await realPool.end();
  redisCtl.disconnect();
  redisSig.disconnect();
  redisCache.disconnect();
});

afterEach(async () => {
  await cleanupOutageProbes(realPool, clientIds);
  clientIds = [];
});

async function leaseKeyExists(clientId: string, instanceId: string): Promise<boolean> {
  const key = tenantKey(ENV, clientId, 'lease', 'i', instanceId);
  const exists = await redisCtl.exists(key);
  return exists === 1;
}

async function buildWorkerOverOutageProxy(outage: OutageSwitch): Promise<{
  worker: SessionWorker;
  bouncerPool: RealPool;
  counting: ReturnType<typeof createCountingSocketFactory>;
}> {
  const bouncerPool = createFailingPoolProxy(realPool, outage) as unknown as RealPool;
  const tenantDb: TenantDb = createTenantDb(bouncerPool);
  const workerDb: WorkerDb = createWorkerDb(bouncerPool);
  const counting = createCountingSocketFactory({ openAfterMs: 5 });

  const worker = createSessionWorker({
    env: ENV,
    workerId: `worker-postgres-outage-${randomUUID()}`,
    pool: bouncerPool,
    tenantDb,
    workerDb,
    redisCtl,
    redisSig,
    redisCache,
    keyProvider: new FileKeyProvider({ ringPath: keyRingPath, mountedPurposes: ['session'] }),
    socketFactory: counting.factory,
    sessionCap: 100,
    timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
  });

  return { worker, bouncerPool, counting };
}

describe('Postgres outage - failure-matrix row "Postgres down" (P26 U6a)', () => {
  it('postgres_outage_stops_sends_but_keeps_sockets_open', async () => {
    const outage: OutageSwitch = { active: false };
    const { worker, counting } = await buildWorkerOverOutageProxy(outage);

    const seeded = [
      await seedOutageInstance(
        realPool,
        { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
        2,
      ),
      await seedOutageInstance(
        realPool,
        { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
        2,
      ),
      await seedOutageInstance(
        realPool,
        { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
        2,
      ),
    ];
    clientIds.push(...seeded.map((s) => s.clientId));
    const allJobIds = seeded.flatMap((s) => s.jobIds);

    for (const s of seeded) {
      const acquired = await worker.startDiscoveredForTest(s.instanceId, s.clientId);
      expect(acquired).toBe(true);
    }
    const openedBeforeOutage = await waitUntil(() => counting.totalOpened() >= 3, 5_000);
    expect(openedBeforeOutage).toBe(true);
    // Waits for `onOpen`'s own ASYNC `saveCreds` + `markLinkedConnected`
    // write to actually land - `link_state`/`health_state` are already
    // 'linked'/'connected' from SEEDING, so they are not a valid signal
    // here; `last_connected_at` is set ONLY by `markLinkedConnected`
    // itself, so it is null until `onOpen` truly finishes. Flipping the
    // outage before this settles would race that in-flight write (still
    // possibly mid-`saveCreds` version-conflict retry) against the proxy.
    const allOpenSettledBeforeOutage = await waitUntil(async () => {
      const rows = await realPool.query<{ last_connected_at: Date | null }>(
        'SELECT last_connected_at FROM whatsapp_instances WHERE id = ANY($1)',
        [seeded.map((s) => s.instanceId)],
      );
      return rows.rows.length === 3 && rows.rows.every((r) => r.last_connected_at !== null);
    }, 5_000);
    expect(allOpenSettledBeforeOutage).toBe(true);

    // --- Outage begins ---
    outage.active = true;
    const claimingDisallowed = await waitUntil(() => !worker.claimingAllowed(), 5_000);
    expect(claimingDisallowed).toBe(true);

    const statusesDuringOutage = await jobStatusesFor(realPool, allJobIds);
    expect(statusesDuringOutage).toEqual(Array(6).fill('queued'));
    expect(await sendAttemptsCountFor(realPool, allJobIds)).toBe(0);

    // Zero self-fences: `registry.has` stays true (teardown() is the ONLY
    // path that ever deletes a registry entry, and it never ran here) for
    // all 3, and the Redis lease keys survive.
    for (const s of seeded) {
      expect(worker.registry.has(s.instanceId)).toBe(true);
      expect(await leaseKeyExists(s.clientId, s.instanceId)).toBe(true);
    }
    // No NEW socket was opened while handling the outage.
    expect(counting.totalOpened()).toBe(3);

    // --- Recovery ---
    outage.active = false;
    const claimingAllowedAgain = await waitUntil(() => worker.claimingAllowed(), 5_000);
    expect(claimingAllowedAgain).toBe(true);

    // No re-open: the counting factory never built a NEW socket for any
    // of these 3 instances - `totalOpened()` stays exactly 3.
    expect(counting.totalOpened()).toBe(3);

    await worker.shutdown();
  }, 30_000);

  it('buffered_creds_saves_are_bounded_at_eight_newest_wins', async () => {
    const seeded = await seedOutageInstance(
      realPool,
      { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
      0,
    );
    clientIds.push(seeded.clientId);

    const store = buildStore(
      { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
      {
        instanceId: seeded.instanceId,
        clientId: seeded.clientId,
        fence: 1n,
        workerId: seeded.workerId,
      },
    );

    const outage: OutageSwitch = { active: true };
    // FIX-P26-I (CRITICAL 1+2): `seedOutageInstance` already seeded this row at cred_version 1.
    const { buffer } = buildOutageGatedBufferWithLiveVersion(store, outage);

    for (let i = 1; i <= 20; i += 1) {
      await expect(
        buffer.save({ creds: { seeded: true, wpDrillSeq: i }, expectedVersion: 0n, fence: 1n }),
      ).resolves.toBeUndefined();
    }

    expect(buffer.size()).toBe(8);
    expect(buffer.dropped()).toBe(12);

    outage.active = false;
    const flushResult = await buffer.flush();
    // FIX-P26-I: seeded at 1, this flush is its first write since seeding, landing at exactly 2n.
    expect(flushResult).toEqual({ applied: true, remaining: 0, credVersion: 2n });

    const freshStore = buildStore(
      { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
      {
        instanceId: seeded.instanceId,
        clientId: seeded.clientId,
        fence: 1n,
        workerId: seeded.workerId,
      },
    );
    const loaded = (await freshStore.loadCreds()) as { wpDrillSeq: number } | null;
    expect(loaded?.wpDrillSeq).toBe(20);

    // A wrong-fence save (outage off) rejects with FenceConflictError and is NOT buffered.
    await expect(
      buffer.save({ creds: { wpDrillSeq: 999 }, expectedVersion: 0n, fence: 999n }),
    ).rejects.toThrow(FenceConflictError);
    expect(buffer.size()).toBe(0);

    buffer.dispose();
  }, 30_000);

  it('only_a_fence_conflict_self_fences_during_and_after_an_outage', async () => {
    const seeded = await seedOutageInstance(
      realPool,
      { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
      0,
    );
    clientIds.push(seeded.clientId);

    let fenceLostCount = 0;
    const store = buildStore(
      { pool: realPool, redisSig, redisCache, redisLease: redisCtl, keyRingPath },
      {
        instanceId: seeded.instanceId,
        clientId: seeded.clientId,
        fence: 1n,
        workerId: seeded.workerId,
      },
      {
        ports: {
          onFenceConflict: async () => {
            fenceLostCount += 1;
          },
        },
      },
    );

    const outage: OutageSwitch = { active: true };
    // FIX-P26-I: see sibling test above - tracks the seeded row's real 1n.
    const { buffer } = buildOutageGatedBufferWithLiveVersion(store, outage);

    for (let i = 1; i <= 20; i += 1) {
      await buffer.save({ creds: { wpDrillSeq: i }, expectedVersion: 0n, fence: 1n });
    }
    expect(fenceLostCount).toBe(0);

    // Recovery: a successful flush clears `unavailable()` so the NEXT save() attempts a
    // LIVE write again; seeded at 1n, so this first flush since seeding lands at exactly 2n.
    outage.active = false;
    const flushResult = await buffer.flush();
    expect(flushResult).toEqual({ applied: true, remaining: 0, credVersion: 2n });
    expect(buffer.unavailable()).toBe(false);

    await expect(
      buffer.save({ creds: { wpDrillSeq: 21 }, expectedVersion: 0n, fence: 999n }),
    ).rejects.toThrow(FenceConflictError);
    expect(fenceLostCount).toBe(1);

    buffer.dispose();
  }, 30_000);
});
