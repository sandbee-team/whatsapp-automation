import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck, type ResultDeps } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedDispatchedAttempt,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * debit.integration.test.ts (P18 Unit U3) - real Postgres, the guard-first
 * debit's single-attempt proofs: replay safety, a zero-row job-outcome
 * write charging nothing, frozen-wallet absorption, and seq/guard/health-
 * state isolation. The mandatory 100x crash-injection chaos proof lives in
 * the sibling `debit-crash-injection.integration.test.ts`; the concurrency
 * proofs (burst continuity, month-boundary repair, claim/debit lock order)
 * live in `debit-concurrency.integration.test.ts` (both split at the
 * max-lines cap, same idiom as `result-failure.integration.test.ts`).
 * Every test reads a money-shaped column `::text` (bigint) and compares
 * strings - never a JS number round-trip.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'debit-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the guard-first debit - real Postgres', () => {
  it('replayed_send_result_leaves_balance_byte_identical', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const input = {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      outcome: { providerMsgId: 'wamid.replay-debit' },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    };

    await resolveAck(input, deps);
    const firstBalance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );

    await expect(resolveAck(input, deps)).rejects.toThrow();

    const secondBalance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(secondBalance.rows[0]?.balance_minor).not.toBeNull();
    expect(secondBalance.rows[0]?.balance_minor).toBe(firstBalance.rows[0]?.balance_minor);

    const guardCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('1');
    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('1');
  });

  it('a_zero_row_result_write_charges_nothing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await pool.query('UPDATE message_jobs SET lease_id = gen_random_uuid() WHERE id = $1', [
      seeded.jobId,
    ]);

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
          outcome: { providerMsgId: 'wamid.zero-row' },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
        },
        deps,
      ),
    ).rejects.toThrow();

    const guardCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('0');
    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('0');

    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('100000');

    const attemptRow = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    expect(attemptRow.rows[0]?.state).toBe('acked');
  });

  it('a_debit_does_not_unfreeze_a_frozen_wallet', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds, {
      walletState: 'frozen',
    });
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [clientId, instanceId, job.id, job.createdAt, job.leaseId],
    );
    const tenantDb = createTenantDb(pool);

    await resolveAck(
      {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attemptNo: 1,
        publicId: job.publicId,
        outcome: { providerMsgId: 'wamid.frozen' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const acctRow = await pool.query<{ state: string; balance_minor: string }>(
      'SELECT state, balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [clientId],
    );
    expect(acctRow.rows[0]?.state).toBe('frozen');
    expect(acctRow.rows[0]?.balance_minor).toBe('99985');

    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('1');
  });

  it('a_debit_stamps_the_guard_with_its_ledger_seq', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.stamp' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const guardRow = await pool.query<{ ledger_seq: string }>(
      'SELECT ledger_seq::text FROM wallet_charge_guards WHERE client_id = $1',
      [seeded.clientId],
    );
    const ledgerRow = await pool.query<{ seq: string }>(
      'SELECT seq::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(guardRow.rows[0]?.ledger_seq).not.toBe('0');
    expect(guardRow.rows[0]?.ledger_seq).toBe(ledgerRow.rows[0]?.seq);
  });

  it('a_debit_never_writes_health_state_or_pause_reason', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const before = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.health' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const after = await pool.query<{ health_state: string; pause_reason: string | null }>(
      'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
