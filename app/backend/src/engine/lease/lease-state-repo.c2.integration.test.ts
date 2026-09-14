import { createPool, createTenantDb, createWorkerDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { release, renewBatch } from './lease-state-repo.js';
import {
  mintFenceInOwnTransaction,
  seedClientAndInstance,
  type TestPool,
  type TestRedis,
} from './__tests__/lease-state-repo-c2-fixtures.js';

/**
 * lease-state-repo.c2.integration.test.ts (P06 C2 all-cases pass) - real
 * Postgres proofs for gaps NOT covered by
 * lease-state-repo.edge.integration.test.ts / stale-fence.integration.test.ts /
 * lease-fence.concurrency.integration.test.ts / lease-release.integration.test.ts:
 *
 *   1. Crash mid-mint-transaction: connection killed after
 *      lease-mint-read-released (FOR UPDATE) but before the upsert commits.
 *   2. Replay of an already-applied write: renewBatch run twice (idempotent,
 *      lease_seen_at advances), release run twice (second is a no-op false).
 *
 * Probes 6-7 (cross-worker interference, retry storm) live in
 * `lease-state-repo.c2.cross-worker.integration.test.ts`, split out of this
 * file to stay under the workspace max-lines limit. Both files share
 * Postgres/Redis lifecycle + seeding helpers via
 * `__tests__/lease-state-repo-c2-fixtures.ts`.
 */

let pool: TestPool;
let redis: TestRedis;
let workerDb: ReturnType<typeof createWorkerDb>;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  redis = createRedis(resolveRedisUrl());
  workerDb = createWorkerDb(pool);
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

describe('probe 1: crash mid-mint-transaction (rollback between the two statements)', () => {
  it('aborting_after_the_FOR_UPDATE_read_but_before_the_upsert_commits_leaves_no_partial_state_row_lock_released_next_mint_succeeds_normally', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'crash-mid-mint',
    );

    // Baseline: mint once cleanly so a real row exists (current_fence = 1)
    // to prove the aborted transaction below did not touch it.
    const baselineFence = await mintFenceInOwnTransaction(
      pool,
      clientId,
      instanceId,
      'worker-baseline',
    );
    expect(baselineFence).toBe(1n);

    const beforeCrash = await pool.query<{ current_fence: string; owner_worker_id: string }>(
      'SELECT current_fence, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(beforeCrash.rows[0]?.current_fence).toBe('1');
    expect(beforeCrash.rows[0]?.owner_worker_id).toBe('worker-baseline');

    // Drive the two mint statements manually (the way lease-state-repo.ts's
    // mintFence does internally) but ROLL BACK after the first (the
    // FOR UPDATE read-released) instead of running the second (the upsert) -
    // simulating a connection kill/crash between the two statements.
    const crashingClient = await pool.connect();
    try {
      await crashingClient.query('BEGIN');
      const readResult = await crashingClient.query<{
        released_at: Date | null;
        owner_worker_id: string | null;
      }>(
        'SELECT released_at, owner_worker_id FROM instance_lease_state WHERE instance_id = $1 AND client_id = $2 FOR UPDATE',
        [instanceId, clientId],
      );
      expect(readResult.rows[0]?.owner_worker_id).toBe('worker-baseline');
      // Simulate the crash: roll back WITHOUT ever running lease-mint-fence's
      // upsert. This releases the FOR UPDATE row lock and discards any
      // in-transaction state - nothing was ever staged for the upsert.
      await crashingClient.query('ROLLBACK');
    } finally {
      crashingClient.release();
    }

    // No partial state: current_fence and owner_worker_id are UNCHANGED
    // from the baseline mint - the aborted read-only half left no trace.
    const afterCrash = await pool.query<{ current_fence: string; owner_worker_id: string }>(
      'SELECT current_fence, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(afterCrash.rows[0]?.current_fence).toBe('1');
    expect(afterCrash.rows[0]?.owner_worker_id).toBe('worker-baseline');

    // The row lock was released by the ROLLBACK (not held indefinitely) -
    // proven by a fresh mint (a full, correct mintFence call) succeeding
    // immediately, without hanging, and bumping the fence normally to 2.
    const subsequentFence = await mintFenceInOwnTransaction(
      pool,
      clientId,
      instanceId,
      'worker-after-crash',
    );
    expect(subsequentFence).toBe(2n);

    const finalRow = await pool.query<{ current_fence: string; owner_worker_id: string }>(
      'SELECT current_fence, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(finalRow.rows[0]?.current_fence).toBe('2');
    expect(finalRow.rows[0]?.owner_worker_id).toBe('worker-after-crash');
  });
});

describe('probe 2: replay of an already-applied write', () => {
  it('the_same_renewBatch_statement_executed_twice_is_idempotent_second_run_still_returns_the_row_lease_seen_at_just_advances', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'replay-renew',
    );
    const fence = await mintFenceInOwnTransaction(pool, clientId, instanceId, 'worker-replay');

    const firstSeenAt = await pool.query<{ lease_seen_at: Date }>(
      'SELECT lease_seen_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );

    // A tiny real delay so `now()` in Postgres actually advances between
    // the two renew calls - this is a genuine two-statement replay, not a
    // simulated clock, so a short real wait is unavoidable here (bounded,
    // deterministic assertion: lease_seen_at strictly increases).
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstRenew = await renewBatch(workerDb, {
      workerId: 'worker-replay',
      leases: [{ instanceId, fence }],
    });
    expect(firstRenew.ok).toBe(true);
    if (firstRenew.ok) {
      expect(firstRenew.renewed.has(instanceId)).toBe(true);
    }

    const secondSeenAt = await pool.query<{ lease_seen_at: Date }>(
      'SELECT lease_seen_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(secondSeenAt.rows[0]!.lease_seen_at.getTime()).toBeGreaterThan(
      firstSeenAt.rows[0]!.lease_seen_at.getTime(),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    // REPLAY: the exact same statement (same worker, same fence) run again -
    // must be idempotent: still returns the row (ok: true, renewed has it),
    // no error, no unique-violation, and lease_seen_at simply advances
    // again (this IS the expected idempotent behavior for a liveness
    // heartbeat - "idempotent" here means "safe to re-run", not "produces
    // byte-identical output").
    const secondRenew = await renewBatch(workerDb, {
      workerId: 'worker-replay',
      leases: [{ instanceId, fence }],
    });
    expect(secondRenew.ok).toBe(true);
    if (secondRenew.ok) {
      expect(secondRenew.renewed.has(instanceId)).toBe(true);
    }

    const thirdSeenAt = await pool.query<{ lease_seen_at: Date }>(
      'SELECT lease_seen_at FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(thirdSeenAt.rows[0]!.lease_seen_at.getTime()).toBeGreaterThan(
      secondSeenAt.rows[0]!.lease_seen_at.getTime(),
    );

    // The fence and owner are untouched by either renew - only liveness
    // bookkeeping changed.
    const finalRow = await pool.query<{ current_fence: string; owner_worker_id: string }>(
      'SELECT current_fence, owner_worker_id FROM instance_lease_state WHERE instance_id = $1',
      [instanceId],
    );
    expect(finalRow.rows[0]?.current_fence).toBe(fence.toString());
    expect(finalRow.rows[0]?.owner_worker_id).toBe('worker-replay');
  });

  it('the_same_release_executed_twice_second_run_returns_false_and_the_row_is_unchanged_released_at_not_re_bumped', async () => {
    const { clientId, instanceId } = await seedClientAndInstance(
      pool,
      probeClientIds,
      'replay-release',
    );
    const fence = await mintFenceInOwnTransaction(
      pool,
      clientId,
      instanceId,
      'worker-replay-release',
    );
    const tenantDb = createTenantDb(pool);

    const firstRelease = await tenantDb.withTenant(clientId, (sql) =>
      release({ clientId, sql }, { instanceId, fence, workerId: 'worker-replay-release' }),
    );
    expect(firstRelease).toBe(true);

    const afterFirstRelease = await pool.query<{
      owner_worker_id: string | null;
      released_at: Date | null;
    }>('SELECT owner_worker_id, released_at FROM instance_lease_state WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(afterFirstRelease.rows[0]?.owner_worker_id).toBeNull();
    const releasedAtAfterFirst = afterFirstRelease.rows[0]?.released_at;
    expect(releasedAtAfterFirst).not.toBeNull();

    // Small real delay so a (buggy) re-bump of released_at would be
    // detectable as a distinct, LATER timestamp - pins that it does NOT
    // happen.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // REPLAY: the exact same release call (same instance, same fence, same
    // worker) run again. `owner_worker_id` is now NULL (cleared by the
    // first release), so the WHERE clause's `owner_worker_id = $worker`
    // predicate can no longer match - PINNED ACTUAL BEHAVIOR: the second
    // call returns false (zero rows matched), and it does NOT throw.
    const secondRelease = await tenantDb.withTenant(clientId, (sql) =>
      release({ clientId, sql }, { instanceId, fence, workerId: 'worker-replay-release' }),
    );
    expect(secondRelease).toBe(false);

    // The row is byte-for-byte unchanged from right after the first
    // release: released_at is NOT re-bumped to a later timestamp (proves
    // the second call's UPDATE genuinely matched zero rows rather than
    // re-applying and silently re-stamping `now()`).
    const afterSecondRelease = await pool.query<{
      owner_worker_id: string | null;
      released_at: Date | null;
    }>('SELECT owner_worker_id, released_at FROM instance_lease_state WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(afterSecondRelease.rows[0]?.owner_worker_id).toBeNull();
    expect(afterSecondRelease.rows[0]?.released_at?.getTime()).toBe(
      releasedAtAfterFirst?.getTime(),
    );
  });
});
