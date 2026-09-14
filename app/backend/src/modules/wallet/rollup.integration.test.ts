import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneWalletRollupSweep } from './rollup.js';

/**
 * rollup.integration.test.ts (P18 Unit U8b) - real Postgres, the daily
 * wallet rollup sweep: two tenants, each with two instances, ledger rows
 * inserted directly as superuser today; the sweep's per-(client, day,
 * instance) output must match the ledger exactly, the workspace SUM must
 * equal the ledger sum, and a re-run must upsert zero rows (idempotent).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'rollup-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function insertLedgerRow(
  clientId: string,
  instanceId: string | null,
  kind: string,
  amountMinor: number,
): Promise<void> {
  const seqResult = await pool.query<{ entry_seq: string }>(
    `UPDATE wallet_accounts SET entry_seq = entry_seq + 1, balance_minor = balance_minor + $2
      WHERE client_id = $1 RETURNING entry_seq`,
    [clientId, amountMinor],
  );
  const seq = seqResult.rows[0]?.entry_seq;
  if (!seq) throw new Error('insertLedgerRow: no wallet_accounts row');

  const balanceResult = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM wallet_accounts WHERE client_id = $1',
    [clientId],
  );
  const balance = balanceResult.rows[0]?.balance_minor;

  await pool.query(
    `INSERT INTO wallet_ledger
       (client_id, seq, kind, amount_minor, balance_after_minor, instance_id, actor_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'system')`,
    [clientId, seq, kind, amountMinor, balance, instanceId],
  );
}

describe('the wallet rollup sweep - real Postgres', () => {
  it('daily_summary_matches_the_ledger_for_the_day', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);

    const secondInstanceA = randomUUID();
    const secondInstanceB = randomUUID();
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'rollup-probe-2', 'connected', 0)`,
      [secondInstanceA, tenantA.clientId],
    );
    await pool.query(
      `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
       VALUES ($1, $2, 'rollup-probe-2', 'connected', 0)`,
      [secondInstanceB, tenantB.clientId],
    );

    for (const [clientId, instanceId] of [
      [tenantA.clientId, tenantA.instanceId],
      [tenantA.clientId, secondInstanceA],
      [tenantB.clientId, tenantB.instanceId],
      [tenantB.clientId, secondInstanceB],
    ] as const) {
      await insertLedgerRow(clientId, instanceId, 'debit_send', -15);
      await insertLedgerRow(clientId, instanceId, 'debit_send', -15);
      await insertLedgerRow(clientId, instanceId, 'refund_send', 15);
    }
    // One credit row with a NULL instance - excluded from the per-instance
    // rollup (wp_wallet_rollup_compute's own `l.instance_id IS NOT NULL`).
    await insertLedgerRow(tenantA.clientId, null, 'signup_credit', 100_000);

    const tenantDb = createTenantDb(pool);
    const result = await runOneWalletRollupSweep({ pool, tenantDb });

    expect(result.daysProcessed).toBe(2);
    expect(result.rowsUpserted).toBe(4);
    expect(result.rowsUnchanged).toBe(0);

    for (const [clientId, instanceId] of [
      [tenantA.clientId, tenantA.instanceId],
      [tenantA.clientId, secondInstanceA],
      [tenantB.clientId, tenantB.instanceId],
      [tenantB.clientId, secondInstanceB],
    ] as const) {
      const row = await pool.query<{
        sent_count: number;
        debit_minor: string;
        refund_minor: string;
        credit_minor: string;
        updated_at: string;
      }>(
        `SELECT sent_count, debit_minor::text, refund_minor::text, credit_minor::text, updated_at::text
           FROM wallet_daily_summary
          WHERE client_id = $1 AND instance_id = $2 AND day = (now() AT TIME ZONE 'UTC')::date`,
        [clientId, instanceId],
      );
      expect(row.rows[0]?.sent_count).toBe(2);
      expect(row.rows[0]?.debit_minor).toBe('30');
      expect(row.rows[0]?.refund_minor).toBe('15');
      expect(row.rows[0]?.credit_minor).toBe('0');
    }

    const ledgerSum = await pool.query<{ debit_minor: string; refund_minor: string }>(
      `SELECT COALESCE(-sum(amount_minor) FILTER (WHERE kind = 'debit_send'), 0)::text AS debit_minor,
              COALESCE(sum(amount_minor) FILTER (WHERE kind = 'refund_send'), 0)::text AS refund_minor
         FROM wallet_ledger
        WHERE client_id = ANY($1) AND instance_id IS NOT NULL`,
      [probeClientIds],
    );
    const summarySum = await pool.query<{ debit_minor: string; refund_minor: string }>(
      `SELECT COALESCE(sum(debit_minor), 0)::text AS debit_minor,
              COALESCE(sum(refund_minor), 0)::text AS refund_minor
         FROM wallet_daily_summary
        WHERE client_id = ANY($1)`,
      [probeClientIds],
    );
    expect(summarySum.rows[0]?.debit_minor).toBe(ledgerSum.rows[0]?.debit_minor);
    expect(summarySum.rows[0]?.refund_minor).toBe(ledgerSum.rows[0]?.refund_minor);

    const beforeRerun = await pool.query<{ updated_at: string }>(
      `SELECT updated_at::text FROM wallet_daily_summary WHERE client_id = ANY($1) ORDER BY client_id, instance_id`,
      [probeClientIds],
    );

    const rerunResult = await runOneWalletRollupSweep({ pool, tenantDb });
    expect(rerunResult.rowsUpserted).toBe(0);

    const afterRerun = await pool.query<{ updated_at: string }>(
      `SELECT updated_at::text FROM wallet_daily_summary WHERE client_id = ANY($1) ORDER BY client_id, instance_id`,
      [probeClientIds],
    );
    expect(afterRerun.rows.map((r) => r.updated_at)).toEqual(
      beforeRerun.rows.map((r) => r.updated_at),
    );
  });
});
