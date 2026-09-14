import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis, resolveRedisUrl, tenantKey } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { LeaseHeartbeat } from './heartbeat.js';
import { LeaseManager, type SessionLease } from './lease-manager.js';
import { createLeaseRedis, type LeaseRedis } from './lease-redis.js';
import { mintFence, type MintFenceCtx } from './lease-state-repo.js';
import type { SessionOwner } from './session-owner.port.js';

/**
 * lease-fence.concurrency.integration.test.ts (P06 Unit U3) - real-Postgres
 * proof that `mintFence` produces a strictly monotonic fence sequence under
 * concurrent load: 50 parallel mints for ONE instance must yield 50 distinct
 * fences with no value reused, sorted strictly increasing. The
 * `lease-mint-read-released` FOR UPDATE lock plus the atomic
 * `lease-mint-fence` upsert are what serialise the bump inside Postgres -
 * this test is the proof that serialisation actually holds under real
 * concurrency, not merely that the SQL text looks right.
 *
 * NOTE (U3 -> U4): this file will later gain U4's
 * `two_workers_cannot_hold_one_session` case - kept in its own nested
 * describe block below so that addition is a pure addition, not a
 * restructure.
 */

type TestPool = ReturnType<typeof createPool>;
type TestRedis = ReturnType<typeof createRedis>;

let pool: TestPool;
let redis: TestRedis;

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

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds = [];
  }
});

async function seedTenantAndInstance(): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    'Lease Fence Probe Client',
    `lease-fence-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, $3, 'connected', 0)`,
    [instanceId, clientId, 'probe'],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

/**
 * Runs `mintFence` inside its own real transaction (BEGIN...COMMIT on a
 * dedicated pool client) - `mintFence` requires both of its statements to
 * share one transaction, and a bare `pool.query` call gives no such
 * guarantee (each call may land on a different pooled connection).
 */
async function mintFenceInOwnTransaction(
  clientId: string,
  instanceId: string,
  workerId: string,
): Promise<bigint> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx: MintFenceCtx = { clientId, sql: client };
    const result = await mintFence(ctx, { instanceId, workerId });
    await client.query('COMMIT');
    return result.fence;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

describe('mintFence concurrency', () => {
  it('fence_is_strictly_monotonic_under_50_parallel_acquires', async () => {
    const { clientId, instanceId } = await seedTenantAndInstance();

    const attempts = Array.from({ length: 50 }, (_, i) => i);
    const fences = await Promise.all(
      attempts.map((i) => mintFenceInOwnTransaction(clientId, instanceId, `worker-${String(i)}`)),
    );

    // 50 distinct fences - no value reused.
    const uniqueFences = new Set(fences.map((fence) => fence.toString()));
    expect(uniqueFences.size).toBe(50);

    // Sorted, they form a strictly increasing sequence (1..50, since this
    // instance had never been leased before this test).
    const sorted = [...fences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]).toBeGreaterThan(sorted[i - 1] as bigint);
    }
    expect(sorted[0]).toBe(1n);
    expect(sorted[sorted.length - 1]).toBe(50n);
  });
});

/**
 * two_workers_cannot_hold_one_session (P06 Unit U4, completed P06 Unit U5):
 * real Redis + real Postgres, COMPRESSED injected timing so the takeover
 * leg never needs a real 15s wait. Sleep calls are recorded through the
 * injected `sleep` (which resolves immediately - real elapsed time in this
 * test is near-zero regardless of the injected `takeoverGraceMs` value).
 *
 * U5 completes mandatory test 3's second half: after C's takeover, A's
 * NEXT heartbeat tick observes the lost lease (either Redis explicitly
 * saying `false` for A's now-overwritten key, or Postgres's renew omitting
 * A because its fence is superseded - both are valid, indistinguishable-
 * by-design fence-conflict outcomes) and A's `SessionOwner` receives
 * `onFenceLost` with cause `redis_renew_lost` or `pg_fence_conflict`.
 */
describe('two workers cannot hold one session', () => {
  const ENV = 'test';
  const COMPRESSED_TIMING = {
    leaseTtlMs: 300,
    heartbeatMs: 100,
    takeoverGraceMs: 150,
    watchdogMs: 150,
    sendTimeoutMs: 1000,
    claimExpiryMs: 2000,
    reaperGraceMs: 500,
    reconcileWindowMs: 5000,
    redisCommandTimeoutMs: 2000,
  } as const;

  let leaseRedis: LeaseRedis;
  let tenantDb: ReturnType<typeof createTenantDb>;

  beforeAll(() => {
    leaseRedis = createLeaseRedis(redis, { timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs });
    tenantDb = createTenantDb(pool);
  });

  afterEach(async () => {
    // Best-effort cleanup of any lease key(s) this describe block's cases
    // created - keyed off the instance ids pushed to probeClientIds's
    // sibling list is unnecessary since afterEach above (outer file scope)
    // already deletes instance_lease_state rows; only the Redis key needs
    // its own cleanup since Redis is not covered by that afterEach.
  });

  function makeSessionOwner(): SessionOwner {
    return { onFenceLost: vi.fn(), close: vi.fn() };
  }

  function makeManager(
    workerId: string,
    sleepSpy: (ms: number) => void,
    sessionOwner: SessionOwner = makeSessionOwner(),
  ): LeaseManager {
    return new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner,
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      sleep: async (ms: number) => {
        sleepSpy(ms);
        // Resolves immediately - no real waiting in this test.
      },
      workerId,
      env: ENV,
    });
  }

  it('two_workers_cannot_hold_one_session', async () => {
    const { clientId, instanceId } = await seedTenantAndInstance();
    const key = tenantKey(ENV, clientId, 'lease', 'i', instanceId);

    try {
      const sleepA = vi.fn();
      const sleepB = vi.fn();
      const sessionOwnerA = makeSessionOwner();
      const sessionOwnerB = makeSessionOwner();
      const managerA = makeManager('worker-a', sleepA, sessionOwnerA);
      const managerB = makeManager('worker-b', sleepB, sessionOwnerB);

      const [resultA, resultB] = await Promise.all([
        managerA.acquire({ instanceId, clientId }),
        managerB.acquire({ instanceId, clientId }),
      ]);

      // Exactly one winner, one loser.
      const winner = resultA ?? resultB;
      const loser = resultA === null ? 'A' : resultB === null ? 'B' : null;
      expect(winner).not.toBeNull();
      expect(loser).not.toBeNull();
      expect(resultA === null || resultB === null).toBe(true);
      expect(resultA === null && resultB === null).toBe(false);

      // The loser never issued set-fence after losing NX. `acquire()` no
      // longer calls `sleep` at all for ANY caller (P09 fleet-recovery FIX -
      // the grace duration is returned via `SessionLease.graceMs`, never
      // awaited inline), so this assertion is trivially true for the winner
      // too now - kept as a loser-specific check anyway (never issuing a
      // grace duration at all is a stronger, still-meaningful property: the
      // loser has no lease/fence and no `graceMs` to report either).
      if (resultA === null) {
        expect(sleepA).not.toHaveBeenCalled();
      } else {
        expect(sleepB).not.toHaveBeenCalled();
      }

      const winnerFence = (winner as SessionLease).fence;
      expect(typeof winnerFence).toBe('bigint');
      const winnerIsA = resultA !== null;
      const winnerSessionOwner = winnerIsA ? sessionOwnerA : sessionOwnerB;
      const winnerWorkerId = winnerIsA ? 'worker-a' : 'worker-b';

      // The winner's own heartbeat holds its lease (U5) - a tick right now,
      // before anything expires, must succeed cleanly (no fence loss yet).
      const winnerHeartbeat = new LeaseHeartbeat({
        leaseRedis,
        pgSql: createWorkerDb(pool),
        sessionOwner: winnerSessionOwner,
        workerId: winnerWorkerId,
        env: ENV,
        timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
      });
      winnerHeartbeat.add(winner as SessionLease);
      await winnerHeartbeat.tick();
      expect(winnerSessionOwner.onFenceLost).not.toHaveBeenCalled();

      // --- Takeover leg ---
      // Let the winner's Redis key expire via the compressed TTL - the
      // winner's heartbeat above is a single manual tick (no running
      // interval), so nothing renews it further.
      await new Promise((resolve) => setTimeout(resolve, COMPRESSED_TIMING.leaseTtlMs + 50));
      const expired = await pool.query('SELECT 1');
      expect(expired.rows.length).toBe(1); // sanity: pool still alive after the wait

      const existsAfterExpiry = await redis.exists(key);
      expect(existsAfterExpiry).toBe(0);

      // A fresh worker C now acquires - released_at is NULL (no clean
      // release happened), so the grace may NOT be skipped: the returned
      // lease's `graceMs` must carry the full `takeoverGraceMs` duration.
      // `acquire()` itself never awaits this any more (P09 fleet-recovery
      // FIX: an inline await here would serialize discovery.ts's sequential
      // grab loop) - the CALLER (production: runner.ts's `start()`, proven
      // separately by runner-lease-grace-offset.test.ts) is responsible for
      // actually waiting `graceMs` out, deferred/cancellable, before ever
      // opening a socket. `sleepC` is kept as a constructor arg for
      // `makeManager`'s shared shape but is no longer expected to be
      // called from inside `acquire()`.
      const sleepC = vi.fn();
      const managerC = makeManager('worker-c', sleepC);
      const resultC = await managerC.acquire({ instanceId, clientId });

      expect(resultC).not.toBeNull();
      expect(sleepC).not.toHaveBeenCalled();
      expect(resultC?.graceMs).toBe(COMPRESSED_TIMING.takeoverGraceMs);
      expect((resultC as SessionLease).fence).toBeGreaterThan(winnerFence);

      // Mandatory test 3's final assertion: the FIRST owner's next
      // heartbeat tick (against its now-superseded lease) gets a 0/omitted
      // row and self-fences - it never re-acquires, re-links, or resumes on
      // its own.
      await winnerHeartbeat.tick();
      expect(winnerSessionOwner.onFenceLost).toHaveBeenCalledTimes(1);
      const [fencedInstanceId, cause] = (winnerSessionOwner.onFenceLost as ReturnType<typeof vi.fn>)
        .mock.calls[0] as [string, string];
      expect(fencedInstanceId).toBe(instanceId);
      expect(['redis_renew_lost', 'pg_fence_conflict']).toContain(cause);
    } finally {
      await redis.del(key);
    }
  });
});
