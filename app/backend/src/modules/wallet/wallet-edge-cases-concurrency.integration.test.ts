import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedDispatchedAttempt,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { resolveAttemptPrice } from './charge.js';
import { refundSend } from './refund.js';
import { UnpricedKeyError } from './pricing.js';

/**
 * wallet-edge-cases-concurrency.integration.test.ts (P18 C2 hardening) -
 * real Postgres, sibling to `wallet-edge-cases.integration.test.ts` (split
 * at the max-lines cap): concurrent-refund races (unique-constraint
 * authority, not a sampled count), the unpriced-tenant fail-closed path,
 * and price-key resolution for group/media/reply recipients.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-concurrency-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet edge cases - concurrency/pricing/unpriced (real Postgres)', () => {
  it('concurrent_refund_from_two_connections_on_the_same_attempt_yields_exactly_one_refund_guard', async () => {
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
        outcome: { providerMsgId: 'wamid.refund-race' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]!.id;

    // Two SEPARATE connections/transactions racing the exact same refund -
    // the (send_attempt_id, kind, created_at) PK is the unique-constraint
    // authority; assert the invariant itself (exactly one winner), never a
    // sampled count.
    const [a, b] = await Promise.all([
      tenantDb.withTenant(seeded.clientId, (tx) =>
        refundSend(tx, { clientId: seeded.clientId, attemptId }),
      ),
      tenantDb.withTenant(seeded.clientId, (tx) =>
        refundSend(tx, { clientId: seeded.clientId, attemptId }),
      ),
    ]);

    const seqs = [a.seq, b.seq].filter((s) => s !== null);
    expect(seqs).toHaveLength(1);
    expect(a.guardRows + b.guardRows).toBe(1);

    const guardCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('1');
  });

  it('resolveAck_prices_a_group_media_recipient_as_group_media_and_a_reply_as_text', async () => {
    const tenant = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    const groupJob = await seedClaimedJob(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
    });
    await pool.query(
      `UPDATE message_jobs SET recipient_jid = $2, payload_kind = 'media' WHERE id = $1`,
      [groupJob.id, `120363012345678901@g.us`],
    );
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [tenant.clientId, tenant.instanceId, groupJob.id, groupJob.createdAt, groupJob.leaseId],
    );
    await resolveAck(
      {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        jobId: groupJob.id,
        jobCreatedAt: groupJob.createdAt,
        leaseId: groupJob.leaseId,
        attemptNo: 1,
        publicId: groupJob.publicId,
        outcome: { providerMsgId: 'wamid.group-media' },
        payloadKind: 'media',
        recipientJid: `120363012345678901@g.us`,
      },
      { tenantDb, rng: fixedRng },
    );
    const groupLedger = await pool.query<{ price_key: string; rate_minor: string }>(
      `SELECT price_key, rate_minor::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'`,
      [tenant.clientId],
    );
    expect(groupLedger.rows[0]?.price_key).toBe('group_media');
    expect(groupLedger.rows[0]?.rate_minor).toBe('25');

    const replyJob = await seedClaimedJob(pool, {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
    });
    await pool.query(`UPDATE message_jobs SET payload_kind = 'reply' WHERE id = $1`, [replyJob.id]);
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [tenant.clientId, tenant.instanceId, replyJob.id, replyJob.createdAt, replyJob.leaseId],
    );
    await resolveAck(
      {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
        jobId: replyJob.id,
        jobCreatedAt: replyJob.createdAt,
        leaseId: replyJob.leaseId,
        attemptNo: 1,
        publicId: replyJob.publicId,
        outcome: { providerMsgId: 'wamid.reply' },
        payloadKind: 'reply',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );
    const replyLedger = await pool.query<{ price_key: string; rate_minor: string }>(
      `SELECT price_key, rate_minor::text FROM wallet_ledger
        WHERE client_id = $1 AND kind = 'debit_send' AND message_job_id = $2`,
      [tenant.clientId, replyJob.id],
    );
    expect(replyLedger.rows[0]?.price_key).toBe('text');
    expect(replyLedger.rows[0]?.rate_minor).toBe('15');
  });

  it('an_unpriced_tenant_fails_closed_job_and_attempt_untouched_zero_money', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    // Remove the tenant's pricing row entirely - resolveRateMinor throws
    // UnpricedKeyError before resolveAck's second transaction opens.
    await pool.query('DELETE FROM client_pricing WHERE client_id = $1', [seeded.clientId]);

    const leaseBefore = await pool.query<{ lease_id: string; status: string }>(
      'SELECT lease_id, status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );

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
          outcome: { providerMsgId: 'wamid.unpriced' },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
        },
        { tenantDb, rng: fixedRng },
      ),
    ).rejects.toThrow(UnpricedKeyError);

    const jobAfter = await pool.query<{ lease_id: string; status: string }>(
      'SELECT lease_id, status FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(jobAfter.rows[0]?.status).toBe(leaseBefore.rows[0]?.status);
    expect(jobAfter.rows[0]?.lease_id).toBe(leaseBefore.rows[0]?.lease_id);

    const attemptAfter = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    // The attempt-state write (first transaction) DID commit - only the
    // wallet/job-outcome (second transaction) never ran.
    expect(attemptAfter.rows[0]?.state).toBe('acked');

    const balance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balance.rows[0]?.balance_minor).toBe('100000');
    const ledgerCount = await pool.query<{ count: string }>(
      'SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('0');

    // resolveAttemptPrice (the repair path's own pricing lookup) fails
    // closed the same way.
    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    await expect(
      tenantDb.withTenant(seeded.clientId, (tx) =>
        resolveAttemptPrice(tx, seeded.clientId, attemptRow.rows[0]!.id),
      ),
    ).rejects.toThrow(UnpricedKeyError);
  });
});
