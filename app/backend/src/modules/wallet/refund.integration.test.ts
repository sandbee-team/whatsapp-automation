import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { seedUnresolvedJob } from '../queue/__tests__/unresolved-test-support.js';
import { retryUnresolved } from '../queue/unresolved.service.js';
import { createCountingNoOpRepairedSendSink } from '../queue/repaired-send-sink.js';
import { createWalletRepairedSendSink } from './wallet-sink.js';
import { refundSend } from './refund.js';

/**
 * refund.integration.test.ts (P18 Unit U4) - real Postgres, the guard-first
 * refund's proofs: exactly-once reversal of a real debit, a no-op when the
 * attempt was never charged (the common `reconciled_lost` shape, driven
 * through the REAL `retryUnresolved` path), frozen-wallet absorption, and
 * the sink fallback being a correct no-op once the in-transaction refund
 * already ran. Every money-shaped column read `::text` (bigint) - never a
 * JS number round-trip.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'refund-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM unresolved_action_keys WHERE client_id = ANY($1)', [
    probeClientIds,
  ]);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('the guard-first refund - real Postgres', () => {
  it('reconciled_lost_refunds_exactly_once', async () => {
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
        outcome: { providerMsgId: 'wamid.refund-debit' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const balanceAfterDebit = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterDebit.rows[0]?.balance_minor).toBe('99985');

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]?.id;
    if (!attemptId) throw new Error('no send_attempts row seeded');

    const first = await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId }),
    );
    expect(first.debitRows).toBe(1);
    expect(first.guardRows).toBe(1);
    expect(first.seq).not.toBeNull();

    const second = await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId }),
    );
    expect(second.debitRows).toBe(1);
    expect(second.guardRows).toBe(0);
    expect(second.seq).toBeNull();

    const guardCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('1');

    const refundGuard = await pool.query<{ ledger_seq: string }>(
      "SELECT ledger_seq::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(refundGuard.rows[0]?.ledger_seq).not.toBe('0');

    const ledgerRow = await pool.query<{
      count: string;
      amount_minor: string;
      rate_minor: string;
      reason: string;
    }>(
      `SELECT count(*)::text AS count,
              (array_agg(amount_minor::text))[1] AS amount_minor,
              (array_agg(rate_minor::text))[1] AS rate_minor,
              (array_agg(reason))[1] AS reason
         FROM wallet_ledger WHERE client_id = $1 AND kind = 'refund_send'`,
      [seeded.clientId],
    );
    expect(ledgerRow.rows[0]?.count).toBe('1');
    expect(ledgerRow.rows[0]?.amount_minor).toBe('15');
    expect(ledgerRow.rows[0]?.rate_minor).toBe('15');
    expect(ledgerRow.rows[0]?.reason).toBe('reconciled_lost');

    const finalAccount = await pool.query<{ balance_minor: string; entry_seq: string }>(
      'SELECT balance_minor::text, entry_seq::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(finalAccount.rows[0]?.balance_minor).toBe('100000');
    expect(finalAccount.rows[0]?.entry_seq).toBe('2');
  });

  it('a_refund_without_a_debit_guard_is_a_no_op', async () => {
    const seeded = await seedUnresolvedJob(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const sink = createCountingNoOpRepairedSendSink();

    const attemptBefore = await pool.query<{ id: string }>(
      `SELECT id FROM send_attempts
        WHERE client_id = $1 AND message_job_id = $2 AND state = 'dispatched'`,
      [seeded.clientId, seeded.jobId],
    );
    const dispatchedAttemptId = attemptBefore.rows[0]?.id;
    if (!dispatchedAttemptId) throw new Error('no dispatched send_attempts row seeded');

    await retryUnresolved(
      { tenantDb, sink, refundSend: (tx, input) => refundSend(tx, input) },
      { kind: 'user', userId: randomUUID() },
      {
        clientId: seeded.clientId,
        jobPublicId: seeded.publicId,
        idempotencyKey: `idem-${seeded.jobId}`,
      },
    );

    const attemptAfter = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE id = $1',
      [dispatchedAttemptId],
    );
    expect(attemptAfter.rows[0]?.state).toBe('reconciled_lost');

    const guardCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(guardCount.rows[0]?.count).toBe('0');
    const ledgerCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('0');
    const balanceRow = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceRow.rows[0]?.balance_minor).toBe('100000');

    // Directly, too: a plain attempt id with no debit guard at all.
    const direct = await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId: dispatchedAttemptId }),
    );
    expect(direct).toEqual({ debitRows: 0, guardRows: 0, seq: null });
  });

  it('a_refund_does_not_unfreeze_a_frozen_wallet', async () => {
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
        outcome: { providerMsgId: 'wamid.refund-frozen' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    await pool.query("UPDATE wallet_accounts SET state = 'frozen' WHERE client_id = $1", [
      seeded.clientId,
    ]);

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]?.id;
    if (!attemptId) throw new Error('no send_attempts row seeded');

    await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId }),
    );

    const acctRow = await pool.query<{ state: string }>(
      'SELECT state FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(acctRow.rows[0]?.state).toBe('frozen');
  });

  it('the_sink_fallback_after_an_in_transaction_refund_is_a_no_op', async () => {
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
        outcome: { providerMsgId: 'wamid.refund-fallback' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]?.id;
    if (!attemptId) throw new Error('no send_attempts row seeded');

    await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId }),
    );
    const balanceAfterFirstRefund = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );

    const sink = createWalletRepairedSendSink({ tenantDb });
    await sink.onReconciledLost(attemptId, seeded.clientId);

    const ledgerCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('1');
    const balanceAfterFallback = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterFallback.rows[0]?.balance_minor).toBe(
      balanceAfterFirstRefund.rows[0]?.balance_minor,
    );
  });
});
