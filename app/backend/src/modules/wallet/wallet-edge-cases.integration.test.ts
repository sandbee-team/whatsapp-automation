import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { resolveAck } from '../../engine/queue/result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { chargeRepairedSend } from './charge.js';
import { refundSend } from './refund.js';

/**
 * wallet-edge-cases.integration.test.ts (P18 C2 hardening) - real Postgres,
 * exact-value edge cases on the guard-first debit/refund seam: crash-then-
 * replay (full rollback + exactly-once replay), replay-with-changed-pricing
 * (guard wins, never re-priced), and refund-after-repricing (reverses the
 * ORIGINAL ledger rate). Sibling `wallet-edge-cases-concurrency.integration.
 * test.ts` covers the remaining edge cases at the max-lines cap.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('wallet edge cases - crash/replay/pricing/refund (real Postgres)', () => {
  it('crash_between_charge_and_commit_rolls_back_fully_then_replay_charges_exactly_once', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const realTenantDb: TenantDb = createTenantDb(pool);

    // withTenant wrapper that lets chargeSend's own transaction run (via
    // resolveAck's SECOND withTenant call) to completion, then throws
    // BEFORE that transaction's own COMMIT - modelling a crash after
    // chargeSend ran but before the transaction committed.
    let calls = 0;
    const crashingDb: TenantDb = {
      async withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
        calls += 1;
        if (calls === 2) {
          return realTenantDb.withTenant(clientId, async (tx) => {
            await fn(tx);
            throw new Error('simulated crash after chargeSend ran, before commit');
          });
        }
        return realTenantDb.withTenant(clientId, fn);
      },
    };

    const input = {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      outcome: { providerMsgId: 'wamid.crash-rollback' },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    };

    await expect(resolveAck(input, { tenantDb: crashingDb, rng: fixedRng })).rejects.toThrow();

    const guardsAfterCrash = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'debit_send'",
      [seeded.clientId],
    );
    expect(guardsAfterCrash.rows[0]?.count).toBe('0');
    const ledgerAfterCrash = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'",
      [seeded.clientId],
    );
    expect(ledgerAfterCrash.rows[0]?.count).toBe('0');
    const balanceAfterCrash = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterCrash.rows[0]?.balance_minor).toBe('100000');

    // Replay: the job UPDATE's own status='processing' predicate still
    // matches (the crashed transaction rolled back), so the SAME resolveAck
    // call now runs to completion via the real tenantDb.
    await resolveAck(input, { tenantDb: realTenantDb, rng: fixedRng });

    const guardsAfterReplay = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_charge_guards WHERE client_id = $1 AND kind = 'debit_send'",
      [seeded.clientId],
    );
    expect(guardsAfterReplay.rows[0]?.count).toBe('1');
    const ledgerAfterReplay = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'",
      [seeded.clientId],
    );
    expect(ledgerAfterReplay.rows[0]?.count).toBe('1');
    const balanceAfterReplay = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balanceAfterReplay.rows[0]?.balance_minor).toBe('99985');
  });

  it('replay_of_an_already_repaired_charge_with_a_changed_price_still_uses_the_ORIGINAL_rate', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    // Mark the attempt settled + job 'sent' (repaired-send shape).
    await pool.query(
      `UPDATE send_attempts SET state = 'acked', resolved_at = now() WHERE message_job_id = $1 AND attempt_no = $2`,
      [seeded.jobId, seeded.attemptNo],
    );
    await pool.query(
      `UPDATE message_jobs SET status = 'sent', sent_at = now(), terminal_at = now() WHERE id = $1`,
      [seeded.jobId],
    );
    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]!.id;

    const first = await chargeRepairedSend(tenantDb, { clientId: seeded.clientId, attemptId }, {});
    expect(first.seq).not.toBeNull();
    const ledgerAfterFirst = await pool.query<{ rate_minor: string }>(
      "SELECT rate_minor::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'",
      [seeded.clientId],
    );
    expect(ledgerAfterFirst.rows[0]?.rate_minor).toBe('15');

    // Change the tenant's price AFTER the charge landed.
    await pool.query(
      `UPDATE client_pricing SET override_items = jsonb_build_object('text', 9999) WHERE client_id = $1`,
      [seeded.clientId],
    );

    // Replay: the guard blocks a second write entirely - never re-priced.
    const second = await chargeRepairedSend(tenantDb, { clientId: seeded.clientId, attemptId }, {});
    expect(second.guardRows).toBe(0);
    expect(second.seq).toBeNull();

    const ledgerAfterReplay = await pool.query<{ count: string; rate_minor: string }>(
      `SELECT count(*)::text AS count, (array_agg(rate_minor::text))[1] AS rate_minor
         FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'`,
      [seeded.clientId],
    );
    expect(ledgerAfterReplay.rows[0]?.count).toBe('1');
    expect(ledgerAfterReplay.rows[0]?.rate_minor).toBe('15');
  });

  it('refund_after_a_price_change_reverses_the_ORIGINAL_ledger_rate_not_the_new_price', async () => {
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
        outcome: { providerMsgId: 'wamid.refund-repriced' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      { tenantDb, rng: fixedRng },
    );

    await pool.query(
      `UPDATE client_pricing SET override_items = jsonb_build_object('text', 500) WHERE client_id = $1`,
      [seeded.clientId],
    );

    const attemptRow = await pool.query<{ id: string }>(
      'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    const attemptId = attemptRow.rows[0]!.id;

    const refund = await tenantDb.withTenant(seeded.clientId, (tx) =>
      refundSend(tx, { clientId: seeded.clientId, attemptId }),
    );
    expect(refund.seq).not.toBeNull();

    const refundLedger = await pool.query<{ amount_minor: string; rate_minor: string }>(
      "SELECT amount_minor::text, rate_minor::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'refund_send'",
      [seeded.clientId],
    );
    // The ORIGINAL rate (15), never the new price (500).
    expect(refundLedger.rows[0]?.amount_minor).toBe('15');
    expect(refundLedger.rows[0]?.rate_minor).toBe('15');

    const balance = await pool.query<{ balance_minor: string }>(
      'SELECT balance_minor::text FROM wallet_accounts WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(balance.rows[0]?.balance_minor).toBe('100000');
  });
});
