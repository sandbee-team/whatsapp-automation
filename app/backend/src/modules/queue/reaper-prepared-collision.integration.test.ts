import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import { dispatch, type DispatchInput } from '../../engine/queue/dispatch.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import {
  cleanupSendProbeClients,
  reclaimRequeuedJob,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep } from './reaper.js';
import {
  crashAfterFirstTransaction,
  expireLease,
  makeReaperDeps,
  SimulatedCrashAfterFirstTransaction,
  unreachableTransport,
} from './__tests__/reaper-prepared-collision-helpers.js';

/**
 * reaper-prepared-collision.integration.test.ts (P12 C1 review, CRITICAL
 * finding 1) - the mandatory suite test 15's SECOND half
 * (`plan/v1/P12-queue-recovery-and-echo-spike.md`: "min(attempts)=0 and the
 * job still terminates at max_attempts"), which was asserted NOWHERE before
 * this file: `reaper.integration.test.ts`'s existing
 * `reaper_never_drives_attempts_negative` only seeds the NO-ATTEMPT branch.
 *
 * This file drives the REAL `dispatch()` (`engine/queue/dispatch.ts`) - not
 * a hand-written INSERT - through one crash -> reap -> reclaim -> re-dispatch
 * cycle, proving a `prepared`-crash repair no longer collides on the next
 * `dispatch()` call (migration 0029's fix: the reaper no longer decrements
 * `attempts` for the `prepared` branch, so `attemptNo = attempts + 1`
 * always names a fresh slot). The REPEATED-cycle termination proof lives in
 * the sibling `reaper-prepared-collision-loop.integration.test.ts` (split at
 * the max-lines cap). Crash-injection helpers shared via
 * `__tests__/reaper-prepared-collision-helpers.ts`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reaper-prepared-collision-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the prepared-crash repair never collides on the next dispatch() attemptNo (real Postgres)', () => {
  it('a_prepared_crash_repair_lets_the_next_real_dispatch_call_succeed_without_colliding', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 5 });

    const realTenantDb = createTenantDb(pool);
    const metrics = bindQueueMetrics(createMetricsRegistry());

    const dispatchInput: DispatchInput = {
      clientId,
      instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: job.leaseId,
      attempts: 0,
      recipientJid: '15550000000@s.whatsapp.net',
      recipientHash: null,
      sendOrigin: null,
      payloadKind: 'text',
      payload: { text: 'hello' },
      publicId: job.publicId,
      fence: 1,
    };

    // Crash right after prepareAndIncrement commits (attempt_no=1 row
    // exists, attempts=1) - before markDispatched/transport.send ever run.
    await expect(
      dispatch(dispatchInput, {
        tenantDb: crashAfterFirstTransaction(realTenantDb),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unreachableTransport is intentionally never called; a full MessageTransport shape is not needed for a path that never reaches transport.send.
        transport: unreachableTransport() as any,
        clock: { now: () => Date.now() },
      }),
    ).rejects.toBeInstanceOf(SimulatedCrashAfterFirstTransaction);

    const beforeReap = await pool.query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(beforeReap.rows[0]).toMatchObject({ attempts: 1, status: 'processing' });
    const attemptRowBefore = await pool.query<{ attempt_no: number; state: string }>(
      'SELECT attempt_no, state FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    expect(attemptRowBefore.rows).toMatchObject([{ attempt_no: 1, state: 'prepared' }]);

    // The reaper repairs it: 30s grace, so simulate an expired lease and sweep.
    await expireLease(pool, job.id);
    await runOneReaperSweep(makeReaperDeps(pool, realTenantDb, metrics));

    const afterReap = await pool.query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    // Migration 0029 fix: attempts is UNCHANGED (still 1) - the collision
    // this test exists to close off would only occur if this were 0.
    expect(afterReap.rows[0]).toMatchObject({ attempts: 1, status: 'queued' });

    // Re-claim through the REAL claimOne() (never a hand-written UPDATE -
    // see reclaimRequeuedJob's own doc) and re-dispatch for real. Before
    // migration 0029 this call would throw DispatchAlreadyRecorded forever
    // (attemptNo recomputed to 1 every time, colliding with the row the
    // crash above already committed) - proving the loop is closed means
    // this call must now SUCCEED.
    const freshLeaseId = await reclaimRequeuedJob(pool, realTenantDb, {
      clientId,
      instanceId,
      jobId: job.id,
      fence: 1,
    });

    const secondDispatchInput: DispatchInput = {
      ...dispatchInput,
      leaseId: freshLeaseId,
      attempts: afterReap.rows[0]?.attempts ?? 1,
    };
    const secondTransport = createFakeTransport();
    secondTransport.queueResolve(0, 'wamid.reaper-collision-proof');

    const result = await dispatch(secondDispatchInput, {
      tenantDb: realTenantDb,
      transport: secondTransport,
      clock: { now: () => Date.now() },
      sendTimeoutMs: 5_000,
      heartbeatIntervalMs: 60_000,
    });

    expect(secondTransport.calls).toHaveLength(1);
    expect(result.outcome).toBe('settled');
    // The critical proof: attemptNo=2, never 1 again - the fresh
    // dispatch() call named a slot with no existing send_attempts row, so
    // no DispatchAlreadyRecorded was thrown.
    expect(result.attemptNo).toBe(2);

    const finalAttemptRows = await pool.query<{ attempt_no: number; state: string }>(
      'SELECT attempt_no, state FROM send_attempts WHERE message_job_id = $1 ORDER BY attempt_no',
      [job.id],
    );
    expect(finalAttemptRows.rows).toMatchObject([
      { attempt_no: 1, state: 'prepared' },
      { attempt_no: 2, state: 'dispatched' },
    ]);
  });
});
