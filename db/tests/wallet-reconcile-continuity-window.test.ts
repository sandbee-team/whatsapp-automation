import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * db/tests/wallet-reconcile-continuity-window.test.ts (P18 fix-round F1,
 * reviewer MAJOR-1/MAJOR-2) - behavioural proof that migration 0057's
 * checkpoint anchor reads the oldest row OF THE 200-ROW BOUNDED WINDOW
 * (`recent`), never the ledger's globally oldest row. Migration 0055's
 * anchor read `ORDER BY wallet_ledger.seq ASC LIMIT 1` unconditionally, so
 * `oldest.seq = checkpoint_seq + 1` only ever fired for a client whose whole
 * history is under 200 rows; once a client crosses 200 ledger entries and a
 * checkpoint exists, the seam between `checkpoint_balance_minor` and the
 * window's oldest row was never validated. Sibling of
 * wallet-reconcile-definer-exec.test.ts (already at the 300-line cap) and
 * wallet-reconcile-definer.test.ts's
 * `continuity_check_reads_at_most_two_hundred_entries_per_client`, which
 * only greps `pg_get_functiondef` for the substring `LIMIT 200` and so could
 * never catch this class of bug - this file replaces that test's coverage
 * role for the window/anchor behaviour (the substring test itself is left
 * unchanged as a cheap first-line guard).
 */
describe('wallet_reconcile_continuity_window', () => {
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
      'Wallet Continuity Window Probe',
      `wallet-continuity-window-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Wallet Continuity Window Probe Client',
      `wallet-continuity-window-probe-${clientId}`,
    ]);
    probeClientIds.push(clientId);
    return clientId;
  }

  /**
   * Seeds 300 consecutive, self-consistent ledger rows (seq 1 signup_credit
   * +100000, then seq 2..300 debit_send -15 each, balance_after exact) and
   * a matching wallet_accounts row: entry_seq 300 / balance_minor = seq
   * 300's balance_after, checkpoint_seq 100 / checkpoint_balance_minor =
   * seq 100's balance_after (an exact, break-free checkpoint anchor).
   */
  async function seedThreeHundredRowLedger(clientId: string): Promise<void> {
    const pool = await getMigratedPool();
    await pool.query(
      `INSERT INTO wallet_accounts (client_id, balance_minor, max_rate_minor, entry_seq, checkpoint_seq, checkpoint_balance_minor)
       VALUES ($1, 0, 100, 300, 100, 0)`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
       VALUES ($1, 1, 'signup_credit', 100000, 100000, 'system', now())`,
      [clientId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
       SELECT $1, gs, 'debit_send', -15, 100000 - (gs - 1) * 15, 'system', now()
         FROM generate_series(2, 300) gs`,
      [clientId],
    );
    await pool.query(
      `UPDATE wallet_accounts SET
          balance_minor = (SELECT balance_after_minor FROM wallet_ledger WHERE client_id = $1 AND seq = 300),
          checkpoint_balance_minor = (SELECT balance_after_minor FROM wallet_ledger WHERE client_id = $1 AND seq = 100)
        WHERE client_id = $1`,
      [clientId],
    );
  }

  it('a_break_older_than_the_window_is_not_reported_and_a_break_at_the_checkpoint_seam_is', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    await seedThreeHundredRowLedger(clientId);

    // Corrupt seq 50's balance_after_minor by +7 - OUTSIDE the 200-row
    // window (seq 101..300). A fixture edit (superuser UPDATE); the
    // function under test never writes.
    await pool.query(
      `UPDATE wallet_ledger SET balance_after_minor = balance_after_minor + 7
        WHERE client_id = $1 AND seq = 50`,
      [clientId],
    );

    // Plant a seam break: checkpoint_balance_minor is 3 more than seq 100's
    // real balance_after_minor, so the anchor check (oldest window row =
    // seq 101 = checkpoint_seq(100) + 1) must fire.
    await pool.query(
      `UPDATE wallet_accounts SET
          checkpoint_balance_minor = (SELECT balance_after_minor FROM wallet_ledger WHERE client_id = $1 AND seq = 100) + 3
        WHERE client_id = $1`,
      [clientId],
    );

    const seamBroken = await pool.query<{
      client_id: string;
      kind: string;
      detail: { seq?: number; anchored_on?: string; expected?: number; actual?: number };
      amount_minor: string;
    }>(
      `SELECT client_id, kind, detail, amount_minor FROM wp_wallet_check_continuity(1000) WHERE client_id = $1`,
      [clientId],
    );

    // Exactly one row: the checkpoint-anchored seam break at seq 101. No
    // row about seq 50/51 - both are outside the 200-row window (101..300).
    expect(seamBroken.rows).toHaveLength(1);
    expect(seamBroken.rows[0]?.kind).toBe('continuity_break');
    expect(seamBroken.rows[0]?.detail.anchored_on).toBe('checkpoint');
    expect(seamBroken.rows[0]?.detail.seq).toBe(101);
    expect(seamBroken.rows[0]?.amount_minor).toBe('-3');

    // Fix the checkpoint value back to the real seq-100 balance -> zero
    // findings (seq 50's corruption stays silent: still outside the window).
    await pool.query(
      `UPDATE wallet_accounts SET
          checkpoint_balance_minor = (SELECT balance_after_minor FROM wallet_ledger WHERE client_id = $1 AND seq = 100)
        WHERE client_id = $1`,
      [clientId],
    );

    const clean = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM wp_wallet_check_continuity(1000) WHERE client_id = $1`,
      [clientId],
    );
    expect(clean.rows).toHaveLength(0);
  });

  it('a_break_inside_the_window_is_reported_exactly_once', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    await seedThreeHundredRowLedger(clientId);

    // Corrupt seq 250's balance_after_minor by +5 - INSIDE the 200-row
    // window (101..300).
    await pool.query(
      `UPDATE wallet_ledger SET balance_after_minor = balance_after_minor + 5
        WHERE client_id = $1 AND seq = 250`,
      [clientId],
    );

    const broken = await pool.query<{
      client_id: string;
      kind: string;
      detail: { seq?: number; prev_seq?: number; expected?: number; actual?: number };
      amount_minor: string;
    }>(
      `SELECT client_id, kind, detail, amount_minor FROM wp_wallet_check_continuity(1000)
        WHERE client_id = $1 ORDER BY (detail->>'seq')::int`,
      [clientId],
    );

    // seq 250's own balance_after is wrong vs 249's balance + amount ->
    // break reported AT 250. seq 251's balance_after is correct (computed
    // from the ORIGINAL, uncorrupted seq 250), but its prev_bal (250's
    // CORRUPTED balance_after) makes ITS OWN arithmetic check fail too ->
    // break reported AT 251 as well. Exactly these two rows, pinned exactly.
    expect(broken.rows).toHaveLength(2);
    expect(broken.rows[0]?.kind).toBe('continuity_break');
    expect(broken.rows[0]?.detail).toMatchObject({
      seq: 250,
      prev_seq: 249,
      expected: 96265,
      actual: 96270,
    });
    expect(broken.rows[0]?.amount_minor).toBe('5');
    expect(broken.rows[1]?.kind).toBe('continuity_break');
    expect(broken.rows[1]?.detail).toMatchObject({
      seq: 251,
      prev_seq: 250,
      expected: 96255,
      actual: 96250,
    });
    expect(broken.rows[1]?.amount_minor).toBe('-5');
  });

  it('the_function_body_has_no_unbounded_ordered_scan_over_the_ledger', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('public.wp_wallet_check_continuity(int)'::regprocedure) AS def`,
    );
    const def = result.rows[0]?.def ?? '';

    const limitTwoHundredMatches = def.match(/LIMIT 200/g) ?? [];
    expect(limitTwoHundredMatches).toHaveLength(1);

    expect(def).not.toMatch(/ORDER BY\s+\S*seq\s+(ASC|DESC)\s+LIMIT\s+1(?!\d)/i);
  });
});
