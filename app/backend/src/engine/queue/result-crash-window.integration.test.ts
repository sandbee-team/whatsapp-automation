import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { resolveAck, resolveFailure, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-crash-window.integration.test.ts (MAJOR 7 fix, P11 gate round) -
 * `resolveAck`/`resolveFailure` deliberately run TWO SEPARATE `withTenant`
 * transactions (see `result.ts`'s own module header): the attempt-state
 * write commits first, on its own, so a crash between the two commits is a
 * real, reachable production state - not hypothetical. This file PRODUCES
 * that exact state (commits the first transaction for real, then simulates
 * the crash by never running the second) and asserts its shape, so P12's
 * reaper inherits a red-line fixture instead of a surprise.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-crash-window-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

class SimulatedCrashAfterFirstTransaction extends Error {
  constructor() {
    super('simulated crash: process died between the two withTenant commits');
    this.name = 'SimulatedCrashAfterFirstTransaction';
  }
}

/**
 * Wraps a real `TenantDb` so the FIRST `withTenant` call runs for real (and
 * commits, since it is a genuinely separate transaction) and every
 * SUBSEQUENT call throws before opening its own transaction - modelling a
 * process crash after the first commit lands but before the second
 * transaction ever begins.
 */
function crashAfterFirstTransaction(real: TenantDb): TenantDb {
  let calls = 0;
  return {
    async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      calls += 1;
      if (calls > 1) {
        throw new SimulatedCrashAfterFirstTransaction();
      }
      return real.withTenant(clientId, fn);
    },
  };
}

describe('the two-transaction crash window (real Postgres)', () => {
  it('an_ack_that_crashes_before_the_second_transaction_leaves_state_acked_and_job_processing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const realTenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb: crashAfterFirstTransaction(realTenantDb), rng: fixedRng };

    await expect(
      resolveAck(
        {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          jobId: seeded.jobId,
          jobCreatedAt: seeded.jobCreatedAt,
          leaseId: seeded.leaseId,
          attemptNo: seeded.attemptNo,
          publicId: seeded.publicId,
          outcome: { providerMsgId: 'wamid.crash-window' },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(SimulatedCrashAfterFirstTransaction);

    // The exact red-line shape: send_attempts.state='acked' (authoritative -
    // a real person received this message) + message_jobs.status is still
    // 'processing' (the second transaction never ran). A reaper must
    // reconcile the JOB from the ATTEMPT row here, never requeue it - that
    // would double-send to a real person.
    const attemptRow = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    expect(attemptRow.rows[0]?.state).toBe('acked');

    const jobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('processing');
  });

  it('a_failure_that_crashes_before_the_second_transaction_leaves_state_failed_and_job_processing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const realTenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb: crashAfterFirstTransaction(realTenantDb), rng: fixedRng };

    await expect(
      resolveFailure(
        {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          jobId: seeded.jobId,
          jobCreatedAt: seeded.jobCreatedAt,
          leaseId: seeded.leaseId,
          attemptNo: seeded.attemptNo,
          publicId: seeded.publicId,
          attempts: 1,
          maxAttempts: 5,
          error: new TransportSendError('transient', 'crash window probe'),
          recipientJid: seeded.recipientJid,
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(SimulatedCrashAfterFirstTransaction);

    const attemptRow = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    expect(attemptRow.rows[0]?.state).toBe('failed');

    const jobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('processing');
  });
});
