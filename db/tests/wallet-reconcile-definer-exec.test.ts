import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * db/tests/wallet-reconcile-definer-exec.test.ts (P18 fix-round, debugger) -
 * sibling of wallet-reconcile-definer.test.ts (already at the 300-line cap):
 * EXECUTES every one of migration 0053/0054's seven wallet definer
 * functions against real data, as opposed to wallet-reconcile-definer.
 * test.ts's `continuity_check_reads_at_most_two_hundred_entries_per_client`,
 * which only greps `pg_get_functiondef` and therefore let migration 0053
 * ship `wp_wallet_check_continuity` with an unqualified `amount_minor`
 * column reference that collides with its own OUT parameter of the same
 * name (`ERROR 42702: column reference "amount_minor" is ambiguous`,
 * raised only at EXECUTION time, never at CREATE time) - see migration
 * 0054's header for the full root cause. This file exists so that class of
 * bug can never ship green again.
 */
describe('wallet_reconcile_definer_exec', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
      await pool.query('DELETE FROM wallet_daily_summary WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM wallet_charge_guards WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM wallet_ledger WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM wallet_accounts WHERE client_id = ANY($1)', [probeClientIds]);
      await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [
        probeClientIds,
      ]);
      await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    }
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  async function createProbeClient(): Promise<string> {
    const pool = await getMigratedPool();
    const userId = randomUUID();
    const clientId = randomUUID();
    await pool.query('INSERT INTO users (id, full_name, email) VALUES ($1, $2, $3)', [
      userId,
      'Wallet Reconcile Exec Probe',
      `wallet-reconcile-exec-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Wallet Reconcile Exec Probe Client',
      `wallet-reconcile-exec-probe-${clientId}`,
    ]);
    probeClientIds.push(clientId);
    return clientId;
  }

  it('continuity_check_executes_and_reports_a_planted_break', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();

    // Self-consistent starting state: seq 1 signup_credit +985 (after 985),
    // seq 2 debit_send -15 (after 970 = 985 - 15) - the account row mirrors
    // that exactly (entry_seq 2, balance_minor 970, checkpoint untouched at
    // 0/0). Calling the function here must report ZERO findings for this
    // client: no continuity_break (seq/balance arithmetic holds throughout
    // the window and at the checkpoint boundary, which is skipped because
    // checkpoint_seq = 0) and no balance_mismatch (newest.balance_after_minor
    // 970 = wallet_accounts.balance_minor 970, entry_seq 2 = max ledger seq).
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, max_rate_minor, entry_seq)
       VALUES ($1, 970, 100, 2)`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
       VALUES ($1, 1, 'signup_credit', 985, 985, 'system', now())`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
       VALUES ($1, 2, 'debit_send', -15, 970, 'system', now())`,
      [clientId],
    );

    const clean = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM wp_wallet_check_continuity(200) WHERE client_id = $1`,
      [clientId],
    );
    expect(clean.rows).toHaveLength(0);

    // Plant the break: seq 3 debit_send -15 is stamped with the WRONG
    // balance_after_minor (900 instead of the arithmetically correct
    // 970 - 15 = 955), and the account row is bumped to match the planted
    // (wrong) ledger state (entry_seq 3, balance_minor 900) so the
    // balance_mismatch check does NOT also fire on the account/ledger
    // comparison - isolating exactly one continuity_break from the window
    // loop. The checkpoint-anchored check stays silent (checkpoint_seq is
    // still 0). The entry_seq-drift check stays silent too (entry_seq 3 =
    // newest.seq 3).
    await pool.query(
      `UPDATE wallet_accounts SET entry_seq = 3, balance_minor = 900 WHERE client_id = $1`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
       VALUES ($1, 3, 'debit_send', -15, 900, 'system', now())`,
      [clientId],
    );

    const broken = await pool.query<{
      client_id: string;
      kind: string;
      detail: { seq?: number; expected?: number; actual?: number };
      amount_minor: string;
    }>(
      `SELECT client_id, kind, detail, amount_minor FROM wp_wallet_check_continuity(200) WHERE client_id = $1`,
      [clientId],
    );

    expect(broken.rows).toHaveLength(1);
    expect(broken.rows[0]?.kind).toBe('continuity_break');
    expect(broken.rows[0]?.detail).toMatchObject({ seq: 3, expected: 955, actual: 900 });
    expect(broken.rows[0]?.amount_minor).toBe('-55');
  });

  it('every_wallet_definer_function_executes_without_error', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const today = await pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'UTC')::date::text AS today`,
    );
    const day = today.rows[0]?.today;
    if (!day)
      throw new Error('every_wallet_definer_function_executes_without_error: no today value');

    await expect(
      pool.query('SELECT * FROM wp_wallet_check_continuity(200)'),
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        `SELECT * FROM wp_wallet_check_missing_debits(now() - interval '1 day', now(), 100)`,
      ),
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        `SELECT * FROM wp_wallet_check_orphan_debits(now() - interval '1 day', now(), 100)`,
      ),
    ).resolves.toBeDefined();
    await expect(
      pool.query('SELECT * FROM wp_wallet_rollup_compute($1, 5000)', [day]),
    ).resolves.toBeDefined();
    await expect(
      pool.query('SELECT * FROM wp_wallet_check_rollup_parity($1, 200)', [day]),
    ).resolves.toBeDefined();
    await expect(
      pool.query('SELECT * FROM wp_wallet_check_orphan_guards(100)'),
    ).resolves.toBeDefined();
    await expect(pool.query('SELECT wp_wallet_count_empty_clients()')).resolves.toBeDefined();

    expect(clientId).toBeDefined();
  });

  it('rollup_parity_ignores_summary_rows_for_other_days', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const instanceId = randomUUID();

    // Seed a wallet_daily_summary row for YESTERDAY only, with no ledger
    // history at all (so wp_wallet_rollup_compute has nothing to compute for
    // either day). Migration 0053's original bug placed `s.day = p_day`
    // inside the FULL OUTER JOIN's ON clause, so this yesterday-only row
    // would incorrectly survive as an unmatched right-side row when querying
    // TODAY, reported as a spurious finding (expected 0, actual <this row's
    // values>) - this test proves migration 0056 filters it out instead.
    await pool.query(
      `INSERT INTO wallet_daily_summary (client_id, day, instance_id, sent_count, debit_minor, credit_minor, refund_minor)
       VALUES ($1, current_date - 1, $2, 1, 15, 0, 0)`,
      [clientId, instanceId],
    );

    const forToday = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM wp_wallet_check_rollup_parity(current_date, 100) WHERE client_id = $1`,
      [clientId],
    );
    expect(forToday.rows).toHaveLength(0);

    // Querying YESTERDAY directly must still report the mismatch: computed
    // (no ledger rows) expects all-zero, but the seeded summary row holds
    // sent_count 1 / debit_minor 15 - two differing fields.
    const forYesterday = await pool.query<{
      client_id: string;
      field: string;
      expected: string;
      actual: string;
    }>(
      `SELECT client_id, field, expected::text, actual::text
         FROM wp_wallet_check_rollup_parity(current_date - 1, 100)
        WHERE client_id = $1
        ORDER BY field`,
      [clientId],
    );
    expect(forYesterday.rows).toEqual([
      { client_id: clientId, field: 'debit_minor', expected: '0', actual: '15' },
      { client_id: clientId, field: 'sent_count', expected: '0', actual: '1' },
    ]);
  });
});
