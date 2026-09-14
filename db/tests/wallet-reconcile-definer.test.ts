import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

interface PgError extends Error {
  code?: string;
}

const WALLET_DEFINER_FUNCTIONS = [
  'wp_wallet_check_continuity',
  'wp_wallet_check_missing_debits',
  'wp_wallet_check_orphan_debits',
  'wp_wallet_rollup_compute',
  'wp_wallet_check_rollup_parity',
  'wp_wallet_check_orphan_guards',
  'wp_wallet_count_empty_clients',
];

/**
 * db/tests/wallet-reconcile-definer.test.ts (P18 U8a) - pins
 * `db/migrations/0053_wallet_reconcile_functions.sql`'s FUNCTION-level
 * surface: ownership/search_path, EXECUTE-grant narrowing, the check-A
 * bounded-read proof, and one behavioral case per remaining check. Follows
 * `reaper-definer.test.ts`'s idiom (no sleeps; every timestamp seeded
 * relative to SQL's own `now()`).
 */
describe('wallet_reconcile_definer', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    const pool = await getMigratedPool();
    if (probeClientIds.length > 0) {
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
      'Wallet Reconcile Probe',
      `wallet-reconcile-probe-${clientId}@example.com`,
    ]);
    await pool.query('INSERT INTO clients (id, company_name, slug) VALUES ($1, $2, $3)', [
      clientId,
      'Wallet Reconcile Probe Client',
      `wallet-reconcile-probe-${clientId}`,
    ]);
    probeClientIds.push(clientId);
    return clientId;
  }

  it('the_wallet_definer_functions_are_owned_by_wp_admin_app_with_a_pinned_search_path', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{
      proname: string;
      owner: string;
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[] | null;
    }>(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)
        ORDER BY p.proname`,
      [WALLET_DEFINER_FUNCTIONS],
    );
    expect(result.rows).toHaveLength(WALLET_DEFINER_FUNCTIONS.length);
    for (const row of result.rows) {
      expect(row.owner, row.proname).toBe('wp_admin_app');
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.provolatile, row.proname).toBe('s');
      const searchPathEntry = row.proconfig?.find((entry) => entry.startsWith('search_path='));
      expect(searchPathEntry, row.proname).toBeDefined();
      expect(searchPathEntry, row.proname).toContain('pg_catalog, public');
    }
  });

  it('only_wp_scheduler_may_execute_the_wallet_definer_functions', async () => {
    const pool = await getMigratedPool();

    for (const fn of WALLET_DEFINER_FUNCTIONS) {
      const execGrants = await pool.query<{ grantee: string }>(
        `SELECT grantee FROM information_schema.role_routine_grants WHERE routine_name = $1`,
        [fn],
      );
      expect(execGrants.rows.map((row) => row.grantee).sort(), fn).toEqual(
        ['wp_admin_app', 'wp_scheduler'].sort(),
      );

      const publicGrant = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.role_routine_grants
          WHERE routine_name = $1 AND grantee = 'PUBLIC'`,
        [fn],
      );
      expect(publicGrant.rows[0]?.count, fn).toBe('0');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_app');
      await expect(
        client.query('SELECT * FROM wp_wallet_count_empty_clients()'),
      ).rejects.toMatchObject<Partial<PgError>>({ code: '42501' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('continuity_check_reads_at_most_two_hundred_entries_per_client', async () => {
    const pool = await getMigratedPool();
    const result = await pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('public.wp_wallet_check_continuity(int)'::regprocedure) AS def`,
    );
    const def = result.rows[0]?.def ?? '';
    expect(def).toContain('LIMIT 200');
    expect(def.toLowerCase()).not.toContain('sum(');
  });

  it('missing_debit_check_finds_an_acked_attempt_without_a_guard_and_ignores_a_guarded_one', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const instanceId = randomUUID();
    await pool.query('INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [
      instanceId,
      clientId,
      'reconcile-probe-instance',
    ]);

    async function seedJobAndAttempt(): Promise<{ jobId: string; attemptId: string }> {
      const jobResult = await pool.query<{ id: string }>(
        `INSERT INTO message_jobs
           (client_id, instance_id, recipient_jid, recipient_e164, payload, payload_kind,
            priority, priority_rank, status, sent_at, terminal_at)
         VALUES ($1, $2, '15550000000@s.whatsapp.net', '+15550000000', '{"text":"probe"}', 'text',
                 'normal', 10, 'sent', now(), now())
         RETURNING id`,
        [clientId, instanceId],
      );
      const jobId = jobResult.rows[0]?.id;
      if (!jobId) throw new Error('seedJobAndAttempt: no job id');
      const attemptResult = await pool.query<{ id: string }>(
        `INSERT INTO send_attempts
           (client_id, instance_id, message_job_id, message_job_created_at, attempt_no, state, resolved_at)
         SELECT $1, $2, $3, j.created_at, 1, 'acked', now() - interval '30 minutes'
           FROM message_jobs j WHERE j.id = $3
         RETURNING id`,
        [clientId, instanceId, jobId],
      );
      const attemptId = attemptResult.rows[0]?.id;
      if (!attemptId) throw new Error('seedJobAndAttempt: no attempt id');
      return { jobId, attemptId };
    }

    const guarded = await seedJobAndAttempt();
    const unguarded = await seedJobAndAttempt();

    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       SELECT $1, 'debit_send', $2, 1, j.created_at FROM message_jobs j WHERE j.id = $3`,
      [guarded.attemptId, clientId, guarded.jobId],
    );

    const result = await pool.query<{ send_attempt_id: string; client_id: string }>(
      `SELECT send_attempt_id, client_id
         FROM wp_wallet_check_missing_debits(now() - interval '1 day', now(), 100)
        WHERE client_id = $1`,
      [clientId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.send_attempt_id).toBe(unguarded.attemptId);
  });

  it('rollup_compute_sums_one_utc_day_per_instance', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const instanceId = randomUUID();
    await pool.query('INSERT INTO whatsapp_instances (id, client_id, label) VALUES ($1, $2, $3)', [
      instanceId,
      clientId,
      'rollup-probe-instance',
    ]);
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, instance_id, created_at)
       VALUES ($1, 1, 'debit_send', -15, 985, 'system', $2, now())`,
      [clientId, instanceId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, instance_id, created_at)
       VALUES ($1, 2, 'refund_send', 15, 1000, 'system', $2, now())`,
      [clientId, instanceId],
    );
    await pool.query(
      `INSERT INTO wallet_ledger (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, instance_id, created_at)
       VALUES ($1, 3, 'signup_credit', 1000, 2000, 'system', NULL, now())`,
      [clientId],
    );

    const today = await pool.query<{ today: string }>(
      `SELECT (now() AT TIME ZONE 'UTC')::date::text AS today`,
    );
    const day = today.rows[0]?.today;
    if (!day) throw new Error('rollup_compute: no today value');

    const result = await pool.query<{
      client_id: string;
      instance_id: string;
      sent_count: number;
      debit_minor: string;
      credit_minor: string;
      refund_minor: string;
    }>(`SELECT * FROM wp_wallet_rollup_compute($1, 5000) WHERE client_id = $2`, [day, clientId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      instance_id: instanceId,
      sent_count: 1,
      debit_minor: '15',
      credit_minor: '0',
      refund_minor: '15',
    });
  });

  it('orphan_guard_check_reports_an_unstamped_guard_older_than_ten_minutes', async () => {
    const pool = await getMigratedPool();
    const clientId = await createProbeClient();
    const oldAttemptId = 900000001;
    const freshAttemptId = 900000002;

    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       VALUES ($1, 'debit_send', $2, 0, now() - interval '11 minutes')`,
      [oldAttemptId, clientId],
    );
    await pool.query(
      `INSERT INTO wallet_charge_guards (send_attempt_id, kind, client_id, ledger_seq, created_at)
       VALUES ($1, 'debit_send', $2, 0, now())`,
      [freshAttemptId, clientId],
    );

    const result = await pool.query<{ send_attempt_id: string }>(
      `SELECT send_attempt_id FROM wp_wallet_check_orphan_guards(100) WHERE client_id = $1`,
      [clientId],
    );
    expect(result.rows.map((row) => row.send_attempt_id)).toEqual([String(oldAttemptId)]);
  });
});
