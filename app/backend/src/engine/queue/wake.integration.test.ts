import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveRedisUrl, createRedis } from '../../platform/redis.js';
import { createMetricsRegistry } from '@wp/server-kit';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { claimOne } from '../../modules/queue/queue.repo.js';
import { dispatch } from './dispatch.js';
import { resolveAck, resolveFailure } from './result.js';
import { bindQueueMetrics } from './metrics.js';
import { runOneSendLoopIteration } from './send-loop.js';
import { createWakeSubscriber, publishWake, wakeChannel } from './wake.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  seedQueuedJob,
  getJobResultRow,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * wake.integration.test.ts (P11 Unit U5, step 8) - the two wake cases that
 * NEED real Postgres + real Redis and a real claim (moved out of
 * `wake.test.ts`, a unit test, per this unit's own dispatch instructions -
 * "judge honestly: if a case needs real infra it belongs in a
 * *.integration.test.ts sibling"):
 *
 *   - `a_dropped_wake_still_drains_via_the_safety_poll`: a subscriber that
 *     was never even started (simulating "disconnected for the whole
 *     enqueue") never sees the wake `publishWake` fires - the job would sit
 *     forever if the wake were the only trigger. The safety-poll timer
 *     itself is NOT re-implemented as a live `setInterval` here (that would
 *     make the test's pass/fail depend on wall-clock timing, exactly what
 *     `.claude/rules/core-invariants.md`'s "no ambient state" rule bans) -
 *     instead this test calls `runOneSendLoopIteration` directly, which is
 *     precisely what production's safety-poll timer does on each tick
 *     (`send-loop.ts`'s own module doc: the wake/timer/poll only ever
 *     decide WHEN to call it). Proving that call drains the job proves the
 *     poll path is correct without depending on real elapsed time.
 *   - `a_wake_for_another_tenants_instance_never_triggers_a_claim`: two
 *     tenants, one worker (isolation suite B shape) - a REAL wake published
 *     on tenant A's channel must never reach a subscriber started for
 *     tenant B's instance, proven against real Redis pub/sub (a channel
 *     string typo here would be invisible to a mock).
 */

let pool: TestPool;
let redisCtl: ReturnType<typeof createRedis>;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'wake-test' });
  redisCtl = createRedis(resolveRedisUrl());
});

afterAll(async () => {
  await pool.end();
  redisCtl.disconnect();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wake - real Postgres + real Redis', () => {
  it('a_dropped_wake_still_drains_via_the_safety_poll', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, { clientId, instanceId });

    // The wake fires, but NO subscriber was ever started for this instance
    // (simulating "disconnected for the whole enqueue") - it is dropped on
    // the floor, exactly as at-most-once pub/sub allows.
    await publishWake(redisCtl, 'test', clientId, instanceId);

    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.safety-poll-1');

    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);

    // This IS what production's mandatory safety-poll timer does on each
    // tick - see this file's own header for why no live timer is used here.
    const result = await runOneSendLoopIteration({
      clientId,
      instanceId,
      workerId: 'worker-safety-poll',
      fence: 1,
      claimOne,
      dispatch: (input, deps) => dispatch(input, deps as never),
      resolveAck: (input, deps) => resolveAck(input, deps as never),
      resolveFailure: (input, deps) => resolveFailure(input, deps as never),
      readMaxAttempts: async (jobId) => {
        const row = await pool.query<{ max_attempts: number }>(
          'SELECT max_attempts FROM message_jobs WHERE id = $1',
          [jobId],
        );
        return row.rows[0]?.max_attempts ?? 5;
      },
      metrics,
      rng: { random: () => 0.5 },
      clock: { now: () => Date.now() },
      ctx: { clientId, sql: pool },
      dispatchDeps: {
        tenantDb,
        transport,
        clock: { now: () => Date.now() },
        sendTimeoutMs: 40,
        heartbeatIntervalMs: 15,
      },
      resultDeps: { tenantDb, rng: { random: () => 0.5 } },
    });

    expect(result).toEqual({ claimed: true });

    const jobRow = await getJobResultRow(pool, job.id);
    expect(jobRow.status).toBe('sent');
    expect(jobRow.sent_at).not.toBeNull();
  });

  it('a_wake_for_another_tenants_instance_never_triggers_a_claim', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);

    const receivedOnB: string[] = [];
    const subscriberRedis = redisCtl.duplicate();
    const subscriber = createWakeSubscriber({
      redis: subscriberRedis,
      env: 'test',
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      onWake: () => {
        receivedOnB.push('woke');
      },
    });
    await subscriber.start();

    try {
      // Publish a wake on TENANT A's channel - tenant B's subscriber must
      // never observe it (real Redis pub/sub, real channel strings). Proved
      // WITHOUT a wall-clock sleep/timing margin: Redis's own `PUBLISH`
      // command resolves synchronously (no client-side event-loop race)
      // with the exact COUNT of subscribers that received the message -
      // that count is the deterministic proof, not an elapsed-time guess.
      const receiverCount = await redisCtl.publish(
        wakeChannel('test', tenantA.clientId, tenantA.instanceId),
        '1',
      );

      // Zero receivers on tenant A's channel - tenant B's subscriber is
      // listening on a DIFFERENT channel and structurally cannot have been
      // counted (real Redis server-side fact, not a client-side race).
      expect(receiverCount).toBe(0);
      expect(receivedOnB).toHaveLength(0);

      // Confirm the tenant-B channel is exactly what wakeChannel derives -
      // proving isolation is structural (different channel strings), not
      // just "didn't happen to fire this run".
      expect(wakeChannel('test', tenantB.clientId, tenantB.instanceId)).not.toBe(
        wakeChannel('test', tenantA.clientId, tenantA.instanceId),
      );

      // Positive control: tenant B's OWN channel (published via the real
      // `publishWake` production entry point) IS observed by tenant B's own
      // subscriber - proves the zero-receiver result above is isolation,
      // not a broken subscriber that would never receive anything.
      await publishWake(redisCtl, 'test', tenantB.clientId, tenantB.instanceId);
      const ownReceiverCount = await redisCtl.publish(
        wakeChannel('test', tenantB.clientId, tenantB.instanceId),
        '1',
      );
      expect(ownReceiverCount).toBe(1);
    } finally {
      await subscriber.stop();
      subscriberRedis.disconnect();
    }
  });
});
