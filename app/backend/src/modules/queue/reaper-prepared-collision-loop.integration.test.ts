import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import { dispatch, type DispatchInput } from '../../engine/queue/dispatch.js';
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
 * reaper-prepared-collision-loop.integration.test.ts (P12 C1 review,
 * CRITICAL finding 1) - split out of `reaper-prepared-collision.integration
 * .test.ts` at the max-lines cap: the REPEATED-cycle termination proof
 * mandatory suite test 15 names ("the job still terminates at
 * max_attempts"), as distinct from the sibling file's single-cycle
 * collision proof. Loops the crash -> reap -> reclaim -> re-dispatch cycle
 * (driving the REAL `dispatch()`, never a hand-written INSERT) enough times
 * to prove the job makes forward progress and terminates rather than
 * spinning - the exact failure mode finding 1 exists to close off.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reaper-prepared-collision-loop-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('repeated prepared-crash cycles still terminate (real Postgres)', () => {
  it('repeated_prepared_crashes_still_terminate_the_job_rather_than_looping_forever', async () => {
    // Seeds a job with maxAttempts=3, crashes it at 'prepared' on every
    // attempt, and asserts the job reaches a state where it is no longer
    // endlessly re-claimable - never spinning past max_attempts.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 3 });

    const realTenantDb = createTenantDb(pool);
    const metrics = bindQueueMetrics(createMetricsRegistry());

    let leaseId = job.leaseId;
    let attemptsSoFar = 0;
    const observedAttemptNos: number[] = [];

    for (let cycle = 0; cycle < 5; cycle += 1) {
      const dispatchInput: DispatchInput = {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId,
        attempts: attemptsSoFar,
        recipientJid: '15550000000@s.whatsapp.net',
        recipientHash: null,
        sendOrigin: null,
        payloadKind: 'text',
        payload: { text: 'hello' },
        publicId: job.publicId,
        fence: 1,
      };

      let threw: unknown;
      try {
        await dispatch(dispatchInput, {
          tenantDb: crashAfterFirstTransaction(realTenantDb),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- unreachableTransport is intentionally never called; a full MessageTransport shape is not needed for a path that never reaches transport.send.
          transport: unreachableTransport() as any,
          clock: { now: () => Date.now() },
        });
      } catch (err) {
        threw = err;
      }

      // Every cycle must crash cleanly (the simulated crash, never
      // DispatchAlreadyRecorded) - a DispatchAlreadyRecorded here would BE
      // the collision bug finding 1 fixes.
      expect(threw).toBeInstanceOf(SimulatedCrashAfterFirstTransaction);

      const attemptRow = await pool.query<{ attempt_no: number }>(
        'SELECT attempt_no FROM send_attempts WHERE message_job_id = $1 ORDER BY attempt_no DESC LIMIT 1',
        [job.id],
      );
      observedAttemptNos.push(attemptRow.rows[0]?.attempt_no ?? -1);

      await expireLease(pool, job.id);
      await runOneReaperSweep(makeReaperDeps(pool, realTenantDb, metrics));

      const afterReap = await pool.query<{ attempts: number; status: string }>(
        'SELECT attempts, status FROM message_jobs WHERE id = $1',
        [job.id],
      );
      const row = afterReap.rows[0];
      if (!row) throw new Error('job vanished mid-loop');

      if (row.status !== 'queued') {
        // Terminal (or otherwise no longer claimable) - stop looping.
        break;
      }

      attemptsSoFar = row.attempts;
      leaseId = await reclaimRequeuedJob(pool, realTenantDb, {
        clientId,
        instanceId,
        jobId: job.id,
        fence: 1,
      });
    }

    // Every observed attempt_no is DISTINCT - the collision bug would have
    // repeated attempt_no=1 forever (DispatchAlreadyRecorded on every cycle
    // after the first, never reaching this assertion at all in that world).
    expect(new Set(observedAttemptNos).size).toBe(observedAttemptNos.length);

    // Termination is asserted DIRECTLY, not merely inferred from a bound:
    // the job must have reached 'failed' (migration 0029's exhausted-
    // 'prepared' branch, mandatory suite test 15's own words - "the job
    // still terminates at max_attempts") strictly BEFORE the loop's full 5
    // allotted iterations - proving the loop exited via the `break` above
    // (exhaustion), never merely running out of budget. attempts never
    // exceeds max_attempts + 1 (the DB's own mj_attempts_range CHECK,
    // migration 0007) - no raw Postgres error ever escaped this loop.
    const finalRow = await pool.query<{
      attempts: number;
      status: string;
      max_attempts: number;
      last_error_class: string | null;
    }>('SELECT attempts, status, max_attempts, last_error_class FROM message_jobs WHERE id = $1', [
      job.id,
    ]);
    const final = finalRow.rows[0];
    if (!final) throw new Error('job vanished');
    expect(final.status).toBe('failed');
    expect(final.last_error_class).toBe('prepared_crash_exhausted');
    expect(final.attempts).toBe(final.max_attempts); // exactly at budget, never past it
    expect(observedAttemptNos.length).toBe(final.max_attempts); // loop exited early, not exhausted its 5-cycle allowance
  });
});
