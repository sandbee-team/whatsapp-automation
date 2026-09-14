import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { FileKeyProvider } from '@wp/server-kit/crypto';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupProbeClients,
  ctxFor,
} from '../../modules/instances/__tests__/instances-test-helpers.js';
import { writeTempSessionKeyRing } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { beginPairingIntent } from '../../modules/instances/index.js';
import { LeaseManager } from '../lease/lease-manager.js';
import { createLeaseRedis } from '../lease/lease-redis.js';
import { createSessionRegistry, createSessionOwner } from './registry.js';
import { createPerWorkerConnectGate } from './connect-gate.js';
import { buildSessionRunnerFor } from './session-worker-runner-factory.js';
import type { FakeSock } from './runner-test-support.js';

/**
 * session-worker-two-workers.c2.integration.test.ts (P08 C2, targeted
 * category 3 - "the P09 preview the fence must already survive") - TWO
 * independent runner compositions (mirroring what `createSessionWorker`
 * wires per worker: its OWN `LeaseManager`/registry/heartbeat/connectGate),
 * driven concurrently against ONE seeded pairing-intent instance. Uses
 * COMPRESSED `takeoverGraceMs: 0` (same technique
 * lease-fence.concurrency.integration.test.ts's own
 * `two_workers_cannot_hold_one_session` case uses) so the race resolves with
 * NO real sleep - this instance was never previously leased, so
 * `prevReleasedAt` is null and the grace step always runs; compressing it to
 * 0 keeps the test deterministic and fast rather than waiting out a real
 * 15s grace.
 *
 * This is deliberately at `buildSessionRunnerFor` + a hand-built
 * `LeaseManager` (not `createSessionWorker` itself, which hard-codes
 * production timing with no override seam) - the fence/registry contract
 * under test is identical either way: `LeaseManager.acquire`'s Redis NX step
 * is the arbiter, exactly as `createSessionWorker`'s bootstrap scan relies
 * on.
 */

const ENV = 'test';
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
} as const;

describe('two worker compositions race one pairing-intent instance', () => {
  let pool: ReturnType<typeof createPool>;
  let redisCtl: ReturnType<typeof createRedis>;
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
    redisCtl?.disconnect();
    redisSig?.disconnect();
    redisCache?.disconnect();
  });

  it('exactly_one_worker_acquires_the_loser_writes_no_instance_state_and_retries_cleanly_next_tick', async () => {
    pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'sw-2w-c2-test' });
    redisCtl = createRedis(resolveRedisUrl());
    redisSig = createRedis(resolveRedisUrl());
    redisCache = createRedis(resolveRedisUrl());

    const clientId = randomUUID();
    const instanceId = randomUUID();

    await pool.query(
      `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
      [clientId, 'Two Worker C2 Probe', `sw-2w-c2-probe-${clientId}`],
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

    const keyProvider = new FileKeyProvider({
      ringPath: writeTempSessionKeyRing(),
      mountedPurposes: ['session'],
    });

    function makeFakeSocketFactory(): { factory: () => FakeSock; sockets: FakeSock[] } {
      const sockets: FakeSock[] = [];
      const factory = () => {
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
        sockets.push(sock);
        return sock;
      };
      return { factory, sockets };
    }

    function buildWorker(workerId: string) {
      const tenantDb = createTenantDb(pool);
      const leaseRedis = createLeaseRedis(redisCtl, {
        timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
      });
      const registry = createSessionRegistry();
      const sessionOwner = createSessionOwner(registry);
      const leaseManager = new LeaseManager({
        leaseRedis,
        tenantDb,
        sessionOwner,
        workerId,
        env: ENV,
        timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      });
      const connectGate = createPerWorkerConnectGate({
        ratePerSec: 100,
        burst: 100,
        clock: { now: () => Date.now() },
        setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
      });
      const { factory, sockets } = makeFakeSocketFactory();

      const runner = buildSessionRunnerFor({
        instanceId,
        clientId,
        env: ENV,
        workerId,
        pool,
        tenantDb,
        redisSig,
        redisCache,
        provider: keyProvider,
        encVersion: 1,
        signalMetrics: {
          incrementHit: vi.fn(),
          incrementMiss: vi.fn(),
          incrementEvicted: vi.fn(),
          incrementDecryptFailure: vi.fn(),
        } as never,
        leaseManager: leaseManager as never,
        heartbeat: { add: vi.fn(), remove: vi.fn() } as never,
        registry,
        sessionOwner,
        connectGate,
        publish: () => undefined,
        socketFactory: factory,
        currentFence: () => 0n,
      });

      return { runner, registry, sockets, workerId };
    }

    const w1 = buildWorker('worker-c2-w1');
    const w2 = buildWorker('worker-c2-w2');

    // Drive both "scan iterations" concurrently - each independently calls
    // runner.start() for the SAME (instanceId, clientId), exactly like two
    // session-worker processes discovering the same pairing-intent row in
    // the same bootstrap-scan tick.
    const [resultW1, resultW2] = await Promise.all([
      w1.runner.start({ instanceId, clientId, method: 'qr' }),
      w2.runner.start({ instanceId, clientId, method: 'qr' }),
    ]);

    const winner = resultW1 !== 'not_acquired' ? w1 : w2;
    const loser = resultW1 !== 'not_acquired' ? w2 : w1;

    // Exactly one acquires.
    expect(resultW1 === 'not_acquired' || resultW2 === 'not_acquired').toBe(true);
    expect(resultW1 === 'not_acquired' && resultW2 === 'not_acquired').toBe(false);

    // The loser's start() returned 'not_acquired' with NO instance state
    // written: no socket built (registry empty for the loser, no fake
    // socket created), no lease row claimed under the loser's worker id.
    expect(loser.sockets.length).toBe(0);
    expect(loser.registry.size).toBe(0);

    const leaseRow = await pool.query<{ owner_worker_id: string | null }>(
      'SELECT owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(leaseRow.rows[0]?.owner_worker_id).toBe(winner.workerId);

    // The winner DID build a real socket and register a real handle.
    // P09 fleet-recovery FIX: the socket build is now deferred behind the
    // connect-gate wait - `winner.registry.size` goes to 1 synchronously
    // (registration happens before the deferred chain), but the socket
    // itself may land a beat later. Poll briefly (real setTimeout, not a
    // bare microtask yield, since the connect-gate here is a real,
    // continuous-refill token bucket) rather than assert synchronous
    // availability.
    expect(winner.registry.size).toBe(1);
    for (let i = 0; i < 100 && winner.sockets.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(winner.sockets.length).toBe(1);

    // The bootstrap scan "does not thrash": the loser retrying on the VERY
    // NEXT tick (instance is still eligible, still owned by the winner) must
    // again cleanly return 'not_acquired' with no throw and no side effect -
    // never an exception propagating out of a legitimately-lost race.
    await expect(loser.runner.start({ instanceId, clientId, method: 'qr' })).resolves.toBe(
      'not_acquired',
    );
    expect(loser.sockets.length).toBe(0);
    expect(loser.registry.size).toBe(0);

    await winner.registry.get(instanceId)?.teardownWithRelease();
  }, 30_000);
});
