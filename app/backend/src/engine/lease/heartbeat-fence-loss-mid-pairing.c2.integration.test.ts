import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseHeartbeat } from './heartbeat.js';
import { LeaseManager } from './lease-manager.js';
import { createLeaseRedis } from './lease-redis.js';
import { createSessionRegistry, createSessionOwner } from '../session/registry.js';
import { createSessionRunner } from '../session/runner.js';
import { createPairingController } from '../session/pairing.js';
import { buildInstancesAdapter } from '../session/runner-test-instances-adapter.js';
import { resolveDisconnect } from '../../provider/baileys/disconnect-map.js';
import { toFsmRow } from '../session/to-fsm-row.js';
import { ctxFor } from '../../modules/instances/__tests__/instances-test-helpers.js';
import * as instancesRepo from '../../modules/instances/repo.js';
import type { InstanceServiceDeps } from '../../modules/instances/service.js';
import type { FakeSock } from '../session/runner-test-support.js';

/**
 * heartbeat-fence-loss-mid-pairing.c2.integration.test.ts (P08 C2, targeted
 * category 4) - a runner holds a real Redis-backed lease mid-pairing; the
 * Redis lease key is deleted from OUTSIDE the process (simulating an
 * operator flush / a competing process's stale cleanup / Redis eviction),
 * then ONE real `LeaseHeartbeat.tick()` is driven. Confirms:
 *   1. `SessionOwner.onFenceLost` fires (registry entry gone after the tick).
 *   2. The runner tears down WITHOUT release (Postgres
 *      `instance_lease_state.released_at` stays NULL - never released,
 *      because this process no longer knows it is safe to).
 *
 * FIXED (P08 FIX BATCH A, A6): the QR pairing branch of runner.ts's
 * `onConnectionUpdate` (the `if (update.qr !== undefined)` block) used to
 * have NO `state.ended`/generation guard, unlike the sibling `'open'` branch
 * (`if (state.ended || generation !== state.sockGeneration) return;`) and the
 * `'close'` branch (`closeInFlightGeneration` single-flight guard). After
 * `onFenceLost` -> `teardownNoRelease()` -> `endSocketOnce()` sets
 * `state.ended = true` and calls `currentSock.end()`, a STILL-CALLABLE `qr`
 * event on the SAME listener closure (a live race between Baileys emitting
 * and `.end()` actually severing the socket, or simply a duplicate/late
 * event already queued) used to still run `deps.pairing.onQr(...)` to
 * completion: it incremented `qr_attempts` in Postgres (the fence-guarded
 * UPDATE's predicate is `current_fence = fence AND owner_worker_id =
 * worker_id` - PURELY a Postgres-side check; nobody re-acquired the Postgres
 * fence in this scenario, so the OLD fence this process captured was still
 * the CURRENT row value, and the write succeeded) and PUBLISHED a fresh
 * `instance.qr` event - even though this process's own `SessionOwner` had
 * already declared the lease lost. The FIX adds the same
 * `state.ended || generation !== state.sockGeneration` guard to the QR
 * branch, BEFORE `pairing.onQr` runs: a late `qr` event after `onFenceLost`
 * teardown now publishes NOTHING and writes NOTHING.
 */

const ENV = 'test';
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 200,
  takeoverGraceMs: 50,
  watchdogMs: 2_000,
  sendTimeoutMs: 1000,
  claimExpiryMs: 2000,
  reaperGraceMs: 500,
  reconcileWindowMs: 5000,
  redisCommandTimeoutMs: 1_000,
} as const;

let pool: ReturnType<typeof createPool>;
let redis: ReturnType<typeof createRedis>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  redis = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

let probeClientIds: string[] = [];
let probeKeys: string[] = [];

afterEach(async () => {
  if (probeKeys.length > 0) {
    await redis.del(...probeKeys);
    probeKeys = [];
  }
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

function makeFakeSock(): FakeSock {
  const handlers = new Map<string, (u: unknown) => unknown>();
  return {
    ev: {
      on(ev: string, cb: (u: unknown) => void) {
        handlers.set(ev, cb);
      },
      async emit(ev: string, payload: unknown) {
        // Bounded poll (real short setTimeout, not a bare microtask yield)
        // for the handler to appear before giving up: this file's own
        // `runner.ts` deps use a REAL `setTimeoutFn` (`(fn, ms) =>
        // setTimeout(fn, ms)`), and the lease acquired above carries a real
        // (compressed, 50ms) `graceMs` for this first-ever mint - `start()`
        // now registers `connection.update` from inside a fire-and-forget
        // deferred chain (connect-gate wait -> grace wait -> offset wait ->
        // `buildAndWireSocket()`, P09 fleet-recovery FIX) that needs that
        // real timer to actually elapse, which a pure microtask poll can
        // never observe.
        let cb = handlers.get(ev);
        for (let i = 0; i < 100 && !cb; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          cb = handlers.get(ev);
        }
        if (!cb) throw new Error(`emit: no handler registered for "${ev}"`);
        await cb(payload);
      },
    },
    end: vi.fn(),
  };
}

describe('heartbeat renew failure mid-pairing tears down and fails closed', () => {
  it('redis_key_deleted_externally_fires_onFenceLost_tears_down_without_release_and_a_late_qr_event_publishes_nothing', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    await pool.query(
      'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
      [clientId, 'Heartbeat Fence Loss Probe', `heartbeat-fence-loss-probe-${clientId}`, 'active'],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances
         (id, client_id, label, health_state, link_state, desired_state, session_epoch, pairing_started_at)
       VALUES ($1, $2, 'probe', 'never_linked', 'pairing', 'online', 0, now())`,
      [instanceId, clientId],
    );
    probeClientIds.push(clientId);
    const key = tenantKey(ENV, clientId, 'lease', 'i', instanceId);
    probeKeys.push(key);

    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const tenantDb = createTenantDb(pool);
    const workerDb = createWorkerDb(pool);
    const registry = createSessionRegistry();
    const sessionOwner = createSessionOwner(registry);
    const workerId = 'worker-fence-loss-c2';

    const leaseManager = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    const lease = await leaseManager.acquire({ instanceId, clientId });
    expect(lease).not.toBeNull();

    const heartbeat = new LeaseHeartbeat({
      leaseRedis,
      pgSql: workerDb,
      sessionOwner,
      workerId,
      env: ENV,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    heartbeat.add(lease!);

    const ctx = ctxFor(pool, clientId);
    const auditSql = pool as unknown as InstanceServiceDeps['auditSql'];
    const serviceDeps: InstanceServiceDeps = { ctx, auditSql };
    const instances = buildInstancesAdapter({
      ctx,
      serviceDeps,
      currentFence: () => lease!.fence,
      workerId,
      currentInstanceId: () => instanceId,
    });

    const publish = vi.fn();
    const sock = makeFakeSock();
    const pairing = createPairingController({
      repoCtx: {
        incrementQrAttempts: async () => {
          const result = await instancesRepo.incrementQrAttempts(ctx, {
            instanceId,
            fence: lease!.fence,
            workerId,
          });
          return { qr_attempts: result.qrAttempts, pairing_started_at: result.pairingStartedAt };
        },
        markPairingExpired: () =>
          instancesRepo.markPairingExpired(ctx, { instanceId, fence: lease!.fence, workerId }),
      },
      publish,
      clock: { now: () => Date.now() },
      clientId,
      instanceId,
    });

    const runner = createSessionRunner({
      leaseManager: {
        acquire: async () => lease,
        release: async () => undefined,
      },
      heartbeat: { add: () => undefined, remove: () => undefined },
      buildAuthStore: () => ({
        store: {
          loadCreds: async () => null,
          saveCreds: async () => ({ credVersion: 1n }),
          getKeys: vi.fn(),
          setKeys: vi.fn(),
          purge: async () => ({ purged: true }),
        },
        signalKeyStore: {},
      }),
      socketFactory: () => sock,
      instances,
      pairing,
      connectGate: { take: async () => undefined },
      publish,
      resolveDisconnect,
      toFsmRow,
      reconnect: {
        nextDelayMs: () => 1000,
        shouldGiveUp: () => false,
        onOpen: () => 0,
      },
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms as number) as unknown,
      clearTimeoutFn: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      logger: { info: () => undefined, warn: vi.fn(), error: vi.fn() },
      workerId,
      env: ENV,
      expectedTakeoverCheck: async () => false,
      registry,
      sessionOwner,
    });

    await runner.start({ instanceId, clientId, method: 'qr' });
    expect(registry.get(instanceId)).toBeDefined();

    // First QR attempt succeeds normally, proving the pairing loop was live
    // BEFORE the fence loss.
    await sock.ev.emit('connection.update', { qr: 'qr-before-fence-loss' });
    expect(publish.mock.calls.some((c) => c[0].type === 'instance.qr')).toBe(true);
    publish.mockClear();

    const rowBeforeLoss = await pool.query<{
      qr_attempts: number;
      health_state: string;
    }>('SELECT qr_attempts, health_state FROM whatsapp_instances WHERE id = $1', [instanceId]);
    const qrAttemptsBeforeLoss = rowBeforeLoss.rows[0]?.qr_attempts;
    const healthBeforeLoss = rowBeforeLoss.rows[0]?.health_state;

    // Kill the Redis lease key from OUTSIDE this process.
    await redis.del(key);

    // Drive exactly one heartbeat tick.
    await heartbeat.tick();

    // onFenceLost fired and the runner tore down WITHOUT release.
    expect(registry.get(instanceId)).toBeUndefined();
    const leaseRowAfterTick = await pool.query<{ released_at: Date | null }>(
      'SELECT released_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseRowAfterTick.rows[0]?.released_at).toBeNull();

    // FIXED (A6) - see this file's header comment. The documented contract
    // is "subsequent engine writes fail closed" (no new 'instance.qr'
    // publish, no qr_attempts advance) once onFenceLost has torn this runner
    // down. A `qr` connection.update on the SAME socket after teardown is now
    // guarded by the same `state.ended || generation !== state.sockGeneration`
    // check the 'open' branch already had, BEFORE `pairing.onQr` runs.
    await sock.ev.emit('connection.update', { qr: 'qr-after-fence-loss' });

    expect(publish.mock.calls.some((c) => c[0].type === 'instance.qr')).toBe(false);

    const rowAfterLoss = await pool.query<{
      qr_attempts: number;
      health_state: string;
    }>('SELECT qr_attempts, health_state FROM whatsapp_instances WHERE id = $1', [instanceId]);
    expect(rowAfterLoss.rows[0]?.qr_attempts).toBe(qrAttemptsBeforeLoss);
    expect(rowAfterLoss.rows[0]?.health_state).toBe(healthBeforeLoss);
  });
});
