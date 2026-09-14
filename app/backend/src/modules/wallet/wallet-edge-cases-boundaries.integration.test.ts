import { randomUUID } from 'node:crypto';
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
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import { runOneWalletRollupSweep } from './rollup.js';

/**
 * wallet-edge-cases-boundaries.integration.test.ts (P18 C2 hardening) -
 * real Postgres, exact-value boundary/state-machine edge cases: the wallet
 * state CASE's low/empty thresholds, truthful overdraft, and the UTC-
 * midnight rollup-day boundary. Sibling `wallet-edge-cases-partitioning.
 * integration.test.ts` covers the guard partition's month boundary and the
 * reconciler window's grace-period edge (split at the max-lines cap).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'wallet-edge-boundaries-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Charges one debit_send of `rateMinor` against a fresh tenant seeded with `balanceMinor`, returns the resulting wallet_accounts row. */
async function debitOnceAndReadAccount(
  balanceMinor: number,
  rateMinor: number,
): Promise<{ balance_minor: string; state: string; health_state: string }> {
  const tenant = await seedSendTenant(pool, probeClientIds, {
    balanceMinor,
    maxRateMinor: rateMinor,
  });
  const tenantDb = createTenantDb(pool);
  const job = await seedClaimedJob(pool, {
    clientId: tenant.clientId,
    instanceId: tenant.instanceId,
  });
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
    [tenant.clientId, tenant.instanceId, job.id, job.createdAt, job.leaseId],
  );
  await pool.query(
    `UPDATE client_pricing SET override_items = jsonb_build_object('text', $2::bigint) WHERE client_id = $1`,
    [tenant.clientId, rateMinor],
  );
  await resolveAck(
    {
      clientId: tenant.clientId,
      instanceId: tenant.instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: job.leaseId,
      attemptNo: 1,
      publicId: job.publicId,
      outcome: { providerMsgId: `wamid.boundary-${randomUUID()}` },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    },
    { tenantDb, rng: fixedRng },
  );
  const row = await pool.query<{ balance_minor: string; state: string }>(
    'SELECT balance_minor::text, state FROM wallet_accounts WHERE client_id = $1',
    [tenant.clientId],
  );
  const health = await pool.query<{ health_state: string }>(
    'SELECT health_state FROM whatsapp_instances WHERE id = $1',
    [tenant.instanceId],
  );
  return {
    balance_minor: row.rows[0]!.balance_minor,
    state: row.rows[0]!.state,
    health_state: health.rows[0]!.health_state,
  };
}

describe('wallet edge cases - state-machine/boundary/timing (real Postgres)', () => {
  it('low_balance_threshold_boundary_exact_values', async () => {
    // default low_balance_threshold_minor = 5000 (schema default), rate = 100.
    // balance - rate < threshold => low; balance = threshold + rate stays
    // active (5100 - 100 = 5000, NOT < 5000).
    const stillActive = await debitOnceAndReadAccount(5100, 100);
    expect(stillActive.state).toBe('active');

    // balance = threshold + rate - 1 => low (5099 - 100 = 4999 < 5000).
    const nowLow = await debitOnceAndReadAccount(5099, 100);
    expect(nowLow.state).toBe('low');
  });

  it('empty_boundary_and_never_touches_health_state', async () => {
    // empty <=> balance - rate < max_rate_minor. max_rate_minor = rate here
    // (seedSendTenant's maxRateMinor param), so balance = max_rate + rate - 1
    // => empty.
    const rate = 100;
    const result = await debitOnceAndReadAccount(rate + rate - 1, rate);
    expect(result.state).toBe('empty');
    // health_state lives on whatsapp_instances, a completely different
    // table the debit-send.sql chain never writes to - the seeded default.
    expect(result.health_state).toBe('connected');
  });

  it('overdraft_is_truthful_two_in_flight_acked_sends_produce_a_negative_balance_and_state_empty', async () => {
    const tenant = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 20,
      maxRateMinor: 15,
    });
    const tenantDb = createTenantDb(pool);

    for (let i = 0; i < 2; i += 1) {
      const job = await seedClaimedJob(pool, {
        clientId: tenant.clientId,
        instanceId: tenant.instanceId,
      });
      await pool.query(
        `INSERT INTO send_attempts
           (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
            attempt_no, state, prepared_at, dispatched_at)
         VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
        [tenant.clientId, tenant.instanceId, job.id, job.createdAt, job.leaseId],
      );
      await resolveAck(
        {
          clientId: tenant.clientId,
          instanceId: tenant.instanceId,
          jobId: job.id,
          jobCreatedAt: job.createdAt,
          leaseId: job.leaseId,
          attemptNo: 1,
          publicId: job.publicId,
          outcome: { providerMsgId: `wamid.overdraft-${String(i)}` },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
        },
        { tenantDb, rng: fixedRng },
      );
    }

    const account = await pool.query<{ balance_minor: string; state: string }>(
      'SELECT balance_minor::text, state FROM wallet_accounts WHERE client_id = $1',
      [tenant.clientId],
    );
    expect(account.rows[0]?.balance_minor).toBe('-10');
    expect(account.rows[0]?.state).toBe('empty');

    const ledgerCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM wallet_ledger WHERE client_id = $1 AND kind = 'debit_send'",
      [tenant.clientId],
    );
    expect(ledgerCount.rows[0]?.count).toBe('2');
  });

  it('utc_midnight_boundary_puts_two_ledger_rows_in_different_rollup_days', async () => {
    const seeded = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDbAsRole(pool, 'wp_app');

    // The real wall-clock's own current UTC day boundary - guaranteed to
    // fall inside an already-seeded wallet_ledger partition (current month,
    // migration 0004), unlike a hardcoded historical date.
    const realNow = new Date();
    const startOfDay2 = new Date(
      Date.UTC(realNow.getUTCFullYear(), realNow.getUTCMonth(), realNow.getUTCDate()),
    );
    const lateOnDay1 = new Date(startOfDay2.getTime() - 1);
    const day1String = lateOnDay1.toISOString().slice(0, 10);
    const day2String = startOfDay2.toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor, actor_type, instance_id, created_at)
       VALUES ($1, 1, 'debit_send', -15, 99985, 'text', 15, 'system', $2, $3)`,
      [seeded.clientId, seeded.instanceId, lateOnDay1],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, price_key, rate_minor, actor_type, instance_id, created_at)
       VALUES ($1, 2, 'debit_send', -15, 99970, 'text', 15, 'system', $2, $3)`,
      [seeded.clientId, seeded.instanceId, startOfDay2],
    );
    await pool.query('UPDATE wallet_accounts SET entry_seq = 2 WHERE client_id = $1', [
      seeded.clientId,
    ]);

    // rollup.ts computes each day as toUtcDayString(now, offset) - inject
    // `now` at the exact instant startOfDay2 lands, processing 2 days
    // (today=2026-06-15, yesterday=2026-06-14) so both ledger rows are
    // covered by ONE sweep call.
    const now = () => startOfDay2;
    await runOneWalletRollupSweep({ pool, tenantDb, now, days: 2 });

    const day1Summary = await pool.query<{ sent_count: number }>(
      `SELECT sent_count FROM wallet_daily_summary WHERE client_id = $1 AND day = $2`,
      [seeded.clientId, day1String],
    );
    expect(day1Summary.rows[0]?.sent_count).toBe(1);

    const day2Summary = await pool.query<{ sent_count: number }>(
      `SELECT sent_count FROM wallet_daily_summary WHERE client_id = $1 AND day = $2`,
      [seeded.clientId, day2String],
    );
    expect(day2Summary.rows[0]?.sent_count).toBe(1);
  });
});
