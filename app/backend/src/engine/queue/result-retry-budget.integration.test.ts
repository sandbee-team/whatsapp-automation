import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { dispatch, type DispatchInput } from './dispatch.js';
import { resolveFailure, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  reclaimRequeuedJob,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-retry-budget.integration.test.ts (CRITICAL 2 fix, P11 gate round) -
 * proves `resolveFailure` now enforces `ResolveFailureInput.maxAttempts`:
 * a `RETRY_BACKOFF`-classified failure that has exhausted its attempt budget
 * goes terminal (status='failed') instead of requeuing forever. Drives the
 * REAL `dispatch()` -> `resolveFailure()` loop (not a hand-seeded attempt
 * count) so the attempt accounting is proved against the same code path
 * production uses, not a fixture assumption about attempts-vs-attemptNo.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-retry-budget-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveFailure - max_attempts is enforced (real Postgres)', () => {
  it('a_job_with_max_attempts_2_makes_exactly_2_attempts_then_goes_terminal', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 2 });
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    const resultDeps: ResultDeps = { tenantDb, rng: fixedRng };

    let attempts = 0;
    let terminal = false;
    let leaseId = job.leaseId;

    // Drive the real dispatch -> resolveFailure loop until the job goes
    // terminal or a safety ceiling is hit (proves it terminates, never spins
    // past maxAttempts).
    for (let i = 0; i < 5 && !terminal; i++) {
      transport.queueReject(0, 'transient', undefined);
      const input: DispatchInput = {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId,
        attempts,
        recipientJid: '15550000000@s.whatsapp.net',
        recipientHash: null,
        sendOrigin: null,
        payloadKind: 'text',
        payload: { text: 'hello' },
        publicId: job.publicId,
        fence: 1,
      };

      const dispatchResult = await dispatch(input, {
        tenantDb,
        transport,
        clock: { now: () => 0 },
        sendTimeoutMs: 5_000,
        heartbeatIntervalMs: 1_000,
      });

      attempts += 1;

      await resolveFailure(
        {
          clientId,
          instanceId,
          jobId: job.id,
          jobCreatedAt: job.createdAt,
          leaseId,
          attemptNo: dispatchResult.attemptNo,
          publicId: job.publicId,
          attempts: attempts - 1,
          maxAttempts: 2,
          error: dispatchResult.sendError as TransportSendError,
          recipientJid: job.recipientJid,
        },
        resultDeps,
      );

      const jobRow = await getJobResultRow(pool, job.id);
      if (jobRow.status === 'failed') {
        terminal = true;
      } else {
        // Requeued - re-claim through the REAL claimOne() (the only
        // statement allowed to perform queued -> processing), which mints a
        // fresh lease_id that the next dispatch()/resolveFailure() call must
        // use instead of the stale one.
        leaseId = await reclaimRequeuedJob(pool, tenantDb, {
          clientId,
          instanceId,
          jobId: job.id,
          fence: 1,
        });
      }
    }

    expect(attempts).toBe(2);

    const jobRow = await getJobResultRow(pool, job.id);
    expect(jobRow.status).toBe('failed');
    expect(jobRow.terminal_at).not.toBeNull();

    const maxAttemptNoRow = await pool.query<{ max: number }>(
      'SELECT max(attempt_no) AS max FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    expect(maxAttemptNoRow.rows[0]?.max).toBe(2);

    // Never claimed again: the claim statement only ever selects
    // status='queued', which this job is no longer.
    const requeued = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1 AND status = $2',
      [job.id, 'queued'],
    );
    expect(requeued.rows.length).toBe(0);
  });

  it('exhaustion_never_trips_the_mj_attempts_range_check_and_never_leaves_a_processing_job_without_an_attempt_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 2 });
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    const resultDeps: ResultDeps = { tenantDb, rng: fixedRng };

    let attempts = 0;
    let leaseId = job.leaseId;
    for (let i = 0; i < 2; i++) {
      transport.queueReject(0, 'transient', undefined);
      const input: DispatchInput = {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId,
        attempts,
        recipientJid: '15550000000@s.whatsapp.net',
        recipientHash: null,
        sendOrigin: null,
        payloadKind: 'text',
        payload: { text: 'hello' },
        publicId: job.publicId,
        fence: 1,
      };

      const dispatchResult = await dispatch(input, {
        tenantDb,
        transport,
        clock: { now: () => 0 },
        sendTimeoutMs: 5_000,
        heartbeatIntervalMs: 1_000,
      });
      attempts += 1;

      await expect(
        resolveFailure(
          {
            clientId,
            instanceId,
            jobId: job.id,
            jobCreatedAt: job.createdAt,
            leaseId,
            attemptNo: dispatchResult.attemptNo,
            publicId: job.publicId,
            attempts: attempts - 1,
            maxAttempts: 2,
            error: dispatchResult.sendError as TransportSendError,
            recipientJid: job.recipientJid,
          },
          resultDeps,
        ),
      ).resolves.toBeUndefined();

      if (i === 0) {
        // Requeued - re-claim through the REAL claimOne(), threading its
        // fresh lease_id into the next iteration (same as the test above).
        leaseId = await reclaimRequeuedJob(pool, tenantDb, {
          clientId,
          instanceId,
          jobId: job.id,
          fence: 1,
        });
      }
    }

    const jobRow = await getJobResultRow(pool, job.id);
    expect(jobRow.status).toBe('failed');

    // No CHECK violation ever means the row must have committed - re-select
    // to prove the transaction is durable, not rolled back.
    const rowStillThere = await pool.query('SELECT 1 FROM message_jobs WHERE id = $1', [job.id]);
    expect(rowStillThere.rows.length).toBe(1);

    // Never left processing without a matching attempt row.
    const stuck = await pool.query(
      `SELECT 1 FROM message_jobs j
        WHERE j.id = $1 AND j.status = 'processing'
          AND NOT EXISTS (SELECT 1 FROM send_attempts a WHERE a.message_job_id = j.id)`,
      [job.id],
    );
    expect(stuck.rows.length).toBe(0);
  });

  it('pause_instance_at_or_over_the_attempt_budget_still_requeues_and_does_not_go_terminal', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 2, maxAttempts: 2 });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 2, 'dispatched', now(), now())`,
      [clientId, instanceId, job.id, job.createdAt, job.leaseId],
    );

    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await resolveFailure(
      {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attemptNo: 2,
        publicId: job.publicId,
        attempts: 2,
        maxAttempts: 2,
        error: new TransportSendError('unknown', 'unrecognized provider signal'),
        recipientJid: job.recipientJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, job.id);
    // PAUSE_INSTANCE is NOT subject to attempt exhaustion - the instance
    // pause is what holds the job, not a terminal failure.
    expect(jobRow.status).toBe('queued');
    expect(jobRow.terminal_at).toBeNull();

    const instanceRow = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [instanceId],
    );
    expect(instanceRow.rows[0]?.health_state).toBe('paused');
  });
});
