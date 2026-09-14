import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedExtraInstance } from '../queue/__tests__/claim-test-helpers.js';
import { claimOne } from '../queue/index.js';
import { chargeRepairedSend } from './charge.js';

/**
 * debit-concurrency.integration.test.ts (P18 Unit U3, split from
 * `debit.integration.test.ts` at the max-lines cap - topic split only, no
 * behavior change, same idiom as `result-failure.integration.test.ts`) -
 * real Postgres, the guard-first debit's concurrency proofs: continuity of
 * `wallet_ledger.seq`/`balance_after_minor` across a concurrent multi-
 * instance burst, a month-boundary repair charging exactly once, and a
 * claim/debit interleave that never deadlocks (40P01). Every test reads a
 * money-shaped column `::text` (bigint) and compares strings - never a JS
 * number round-trip.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'debit-concurrency-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the guard-first debit - concurrency (real Postgres)', () => {
  it('balance_after_minor_is_continuous_across_a_concurrent_burst', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const instanceB = await seedExtraInstance(pool, clientId);
    const instanceC = await seedExtraInstance(pool, clientId);
    const instances = [instanceId, instanceB, instanceC];
    const tenantDb = createTenantDb(pool);

    const jobs = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const inst = instances[i % instances.length]!;
        const job = await seedClaimedJob(pool, { clientId, instanceId: inst });
        await pool.query(
          `INSERT INTO send_attempts
             (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
              attempt_no, state, prepared_at, dispatched_at)
           VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
          [clientId, inst, job.id, job.createdAt, job.leaseId],
        );
        return { job, instanceId: inst };
      }),
    );

    await Promise.all(
      jobs.map(({ job, instanceId: inst }, i) =>
        resolveAck(
          {
            clientId,
            instanceId: inst,
            jobId: job.id,
            jobCreatedAt: job.createdAt,
            leaseId: job.leaseId,
            attemptNo: 1,
            publicId: job.publicId,
            outcome: { providerMsgId: `wamid.burst-${String(i)}` },
            payloadKind: 'text',
            recipientJid: '15550000000@s.whatsapp.net',
          },
          { tenantDb, rng: fixedRng },
        ),
      ),
    );

    const ledgerRows = await pool.query<{
      seq: string;
      amount_minor: string;
      balance_after_minor: string;
    }>(
      'SELECT seq::text, amount_minor::text, balance_after_minor::text FROM wallet_ledger WHERE client_id = $1 ORDER BY wallet_ledger.seq',
      [clientId],
    );
    expect(ledgerRows.rows.length).toBe(30);
    expect(ledgerRows.rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => String(i + 1)),
    );

    let expectedBalance = 100_000;
    for (const row of ledgerRows.rows) {
      expectedBalance += Number(row.amount_minor);
      expect(row.balance_after_minor).toBe(String(expectedBalance));
    }

    const finalBalance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(finalBalance.rows[0]?.balance_minor).toBe(String(expectedBalance));
    expect(finalBalance.rows[0]?.balance_minor).toBe(String(100_000 - 30 * 15));
  });

  it('a_repair_across_a_month_boundary_still_charges_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await pool.query(
      "SELECT public.wp_ensure_month_partition('message_jobs'::regclass, (now() - interval '1 month')::date)",
    );
    await pool.query(
      "SELECT public.wp_ensure_month_partition('wallet_charge_guards'::regclass, (now() - interval '1 month')::date)",
    );

    const jobResult = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at,
          created_at, sent_at, terminal_at)
       VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'sent',
               now() - interval '1 month', now() - interval '1 month', 0, 5, 'worker-1',
               gen_random_uuid(), 1, now() - interval '1 month', now() - interval '1 month',
               now() - interval '1 month', now() - interval '1 month', now() - interval '1 month')
       RETURNING id, created_at`,
      [clientId, instanceId, '15559990000@s.whatsapp.net', JSON.stringify({ text: 'hello' })],
    );
    const job = jobResult.rows[0]!;

    // message_job_created_at is read IN-STATEMENT from message_jobs, never
    // bound as the JS Date `job.created_at` above - a JS Date truncates to
    // millisecond precision and Postgres stores microseconds, so a bound
    // Date here would silently fail to join back to the job row (the exact
    // trap `dispatch.ts`'s own module doc warns about).
    const attemptResult = await pool.query<{ id: string }>(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, gen_random_uuid(), 1, 'acked',
              now() - interval '1 month', now() - interval '1 month', now() - interval '1 month'
         FROM message_jobs j WHERE j.id = $3
       RETURNING id`,
      [clientId, instanceId, job.id],
    );
    const attemptId = attemptResult.rows[0]!.id;

    const tenantDb = createTenantDb(pool);
    const first = await chargeRepairedSend(tenantDb, { clientId, attemptId }, {});
    expect(first.jobRows).toBe(1);
    expect(first.guardRows).toBe(1);
    expect(first.seq).not.toBeNull();

    const second = await chargeRepairedSend(tenantDb, { clientId, attemptId }, {});
    expect(second.guardRows).toBe(0);

    const guardCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND send_attempt_id = $2',
      [clientId, attemptId],
    );
    expect(guardCount.rows[0]?.count).toBe('1');
    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND send_attempt_id = $2',
      [clientId, attemptId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('1');
  });

  it('a_claim_and_a_debit_do_not_deadlock', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const queuedJobIds: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
            payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
         VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
         RETURNING id`,
        [
          clientId,
          instanceId,
          `${String(i)}deadlock@s.whatsapp.net`,
          JSON.stringify({ text: 'hello' }),
        ],
      );
      queuedJobIds.push(result.rows[0]!.id);
    }

    const dispatchedJobs: Array<{
      id: string;
      createdAt: Date;
      leaseId: string;
      publicId: string;
    }> = [];
    for (let i = 0; i < 200; i += 1) {
      const job = await seedClaimedJob(pool, { clientId, instanceId });
      await pool.query(
        `INSERT INTO send_attempts
           (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
            attempt_no, state, prepared_at, dispatched_at)
         VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
        [clientId, instanceId, job.id, job.createdAt, job.leaseId],
      );
      dispatchedJobs.push(job);
    }

    const errors: unknown[] = [];
    let debitCount = 0;
    const batchSize = 20;
    for (let start = 0; start < 200; start += batchSize) {
      const claimBatch = queuedJobIds.slice(start, start + batchSize).map((jobId) =>
        tenantDb
          .withTenant(clientId, (tx) =>
            claimOne(
              { clientId, sql: tx },
              {
                instanceId,
                band: 10,
                fence: 1,
                workerId: `deadlock-worker-${String(jobId)}`,
                claimExpiryMs: 90_000,
              },
            ),
          )
          .catch((err: unknown) => errors.push(err)),
      );
      const debitBatch = dispatchedJobs.slice(start, start + batchSize).map((job, idx) =>
        resolveAck(
          {
            clientId,
            instanceId,
            jobId: job.id,
            jobCreatedAt: job.createdAt,
            leaseId: job.leaseId,
            attemptNo: 1,
            publicId: job.publicId,
            outcome: { providerMsgId: `wamid.deadlock-${String(start + idx)}` },
            payloadKind: 'text',
            recipientJid: '15550000000@s.whatsapp.net',
          },
          { tenantDb, rng: fixedRng },
        )
          .then(() => {
            debitCount += 1;
          })
          .catch((err: unknown) => errors.push(err)),
      );
      await Promise.all([...claimBatch, ...debitBatch]);
    }

    const deadlockErrors = errors.filter(
      (err) => err instanceof Error && (err as Error & { code?: string }).code === '40P01',
    );
    expect(deadlockErrors.length).toBe(0);
    expect(debitCount).toBe(200);
  });
});
