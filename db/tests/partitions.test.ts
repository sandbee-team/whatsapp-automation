import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ensureAllPartitions } from '../src/index.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  createPartitionProbeTable,
  dropY2032TestPartitions,
  fetchUnkeyedUniqueIndexes,
} from './helpers/partition-fixtures.js';

/**
 * Tests for migration 0003 (`wp_ensure_month_partition`) - see
 * `plan/v1/P02-db-foundations-and-isolation.md` step 5. `wp_part_probe` is a
 * throwaway partitioned table used only by the first two cases; it is
 * always dropped in `afterEach` (parent DROP takes its partitions with it)
 * so the dev DB stays clean for the generic catalog scan in the third case
 * and for later isolation tests that enumerate all tables.
 */
describe('partitions', () => {
  afterEach(async () => {
    const pool = await getMigratedPool();
    await pool.query('DROP TABLE IF EXISTS wp_part_probe CASCADE');
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('a_new_month_partition_has_client_id_rls_enabled_and_forced', async () => {
    const pool = await getMigratedPool();

    await createPartitionProbeTable(pool);

    await pool.query("SELECT wp_ensure_month_partition('wp_part_probe', DATE '2026-08-15')");

    const partitionCheck = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = 'wp_part_probe_y2026m08'`,
    );
    expect(partitionCheck.rowCount).toBe(1);
    expect(partitionCheck.rows[0]?.relrowsecurity).toBe(true);
    expect(partitionCheck.rows[0]?.relforcerowsecurity).toBe(true);

    const policyCheck = await pool.query(
      `SELECT policyname
         FROM pg_policies
        WHERE tablename = 'wp_part_probe_y2026m08' AND policyname = 'tenant_isolation'`,
    );
    expect(policyCheck.rowCount).toBe(1);

    // Bounds check: a row dated within August routes to the August
    // partition; a row dated in September has no matching partition at all
    // (the parent has only the one August child), proving FROM/TO are the
    // calendar month, not some other window.
    await pool.query(`INSERT INTO wp_part_probe (client_id, created_at) VALUES ($1, $2)`, [
      randomUUID(),
      '2026-08-31 23:59:00+00',
    ]);
    const inAugust = await pool.query(
      `SELECT 1 FROM wp_part_probe_y2026m08 WHERE created_at = '2026-08-31 23:59:00+00'`,
    );
    expect(inAugust.rowCount).toBe(1);

    await expect(
      pool.query(`INSERT INTO wp_part_probe (client_id, created_at) VALUES ($1, $2)`, [
        randomUUID(),
        '2026-09-01 00:00:00+00',
      ]),
    ).rejects.toThrow();
  });

  it('ensure_month_partition_is_idempotent', async () => {
    const pool = await getMigratedPool();

    await createPartitionProbeTable(pool);

    await pool.query("SELECT wp_ensure_month_partition('wp_part_probe', DATE '2026-08-15')");
    await pool.query("SELECT wp_ensure_month_partition('wp_part_probe', DATE '2026-08-15')");

    const partitionCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_inherits
        WHERE inhparent = 'wp_part_probe'::regclass`,
    );
    expect(partitionCount.rows[0]?.count).toBe(1);

    const policyCount = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_policies
        WHERE tablename = 'wp_part_probe_y2026m08'`,
    );
    expect(policyCount.rows[0]?.count).toBe(1);
  });

  it('no_unique_index_on_a_partitioned_table_without_the_partition_key', async () => {
    const pool = await getMigratedPool();

    // Blueprint mandatory test 21 - generic catalog scan, no probe table.
    // For every partitioned parent in `public` AND every one of its
    // partition children, every UNIQUE index (including PKs) must include
    // all of the parent's partition-key columns. Postgres allows a UNIQUE
    // index created directly on one child that omits the key - that is
    // per-partition uniqueness only, silently NOT global uniqueness.
    const rows = await fetchUnkeyedUniqueIndexes(pool);

    expect(rows).toEqual([]);
  });

  /**
   * C2 close-out addition: `wallet_ledger` is the one real (non-probe) table
   * that seeds partitions via `wp_ensure_month_partition` at migration time
   * (migration 0004, "current + next 2 months"). These two cases pin the
   * exact clock-boundary behaviour that seeding pattern depends on, using a
   * far-future month pair (2031-01/02) so they never collide with whatever
   * months are actually seeded on the shared dev database - each test seeds
   * only the month(s) it needs and drops its own partition child(ren) in a
   * `finally`, never touching the real current-month partitions other suites
   * rely on. `wallet_ledger.client_id` has no FK (append-only hot path, see
   * migration 0004), so probe rows need no `clients`/`users` fixture.
   */
  it('wallet_ledger_rows_route_correctly_at_the_exact_month_boundary_instant_and_reject_unseeded_months', async () => {
    const pool = await getMigratedPool();

    try {
      await pool.query(
        "SELECT wp_ensure_month_partition('wallet_ledger'::regclass, DATE '2031-02-01')",
      );
      // Deliberately do NOT seed January or March 2031: both sides of the
      // gap must fail loudly, not silently misroute.

      async function insertAt(createdAt: string): Promise<string> {
        const clientId = randomUUID();
        await pool.query(
          `INSERT INTO wallet_ledger
             (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
           VALUES ($1, 1, 'signup_credit', 100, 100, 'system', $2)`,
          [clientId, createdAt],
        );
        return clientId;
      }

      // Lower bound, inclusive: the FROM instant itself lands in February.
      const firstInstant = await insertAt('2031-02-01 00:00:00+00');
      const firstCheck = await pool.query(
        'SELECT 1 FROM wallet_ledger_y2031m02 WHERE client_id = $1',
        [firstInstant],
      );
      expect(firstCheck.rowCount).toBe(1);

      // Upper bound, exclusive: the last representable microsecond of
      // February still lands in February (not spilled into an unseeded
      // March).
      const lastInstant = await insertAt('2031-02-28 23:59:59.999999+00');
      const lastCheck = await pool.query(
        'SELECT 1 FROM wallet_ledger_y2031m02 WHERE client_id = $1',
        [lastInstant],
      );
      expect(lastCheck.rowCount).toBe(1);

      // One microsecond past the FROM boundary going backwards (still
      // January, unseeded) - must reject loudly, never silently drop or
      // misroute into February.
      await expect(insertAt('2031-01-31 23:59:59.999999+00')).rejects.toThrow(
        /no partition of relation/i,
      );

      // Exactly the TO boundary (first instant of unseeded March) - must
      // reject loudly too: proves TO is exclusive and there is no silent
      // fallback to the nearest seeded partition.
      await expect(insertAt('2031-03-01 00:00:00+00')).rejects.toThrow(/no partition of relation/i);
    } finally {
      await pool.query('DROP TABLE IF EXISTS wallet_ledger_y2031m02');
    }
  });

  it('wallet_ledger_partition_routing_follows_the_absolute_instant_not_the_literal_calendar_text', async () => {
    const pool = await getMigratedPool();

    try {
      await pool.query(
        "SELECT wp_ensure_month_partition('wallet_ledger'::regclass, DATE '2031-02-01')",
      );
      // January is deliberately left unseeded - the second half of this test
      // relies on it being absent.

      // Literal text reads "January 31", but the -05:00 offset makes the
      // absolute instant 2031-02-01T00:00:00Z - it must land in February,
      // proving routing is instant-based, not based on the date substring of
      // the input.
      const looksJanuaryIsFebruary = randomUUID();
      await pool.query(
        `INSERT INTO wallet_ledger
           (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
         VALUES ($1, 1, 'signup_credit', 100, 100, 'system', '2031-01-31 19:00:00-05:00')`,
        [looksJanuaryIsFebruary],
      );
      const inFebruary = await pool.query(
        'SELECT 1 FROM wallet_ledger_y2031m02 WHERE client_id = $1',
        [looksJanuaryIsFebruary],
      );
      expect(inFebruary.rowCount).toBe(1);

      // Literal text reads "February 1", but the +05:00 offset makes the
      // absolute instant 2031-01-31T22:00:00Z - still January (unseeded), so
      // it must reject rather than silently land in the seeded February
      // partition just because the text says "February".
      await expect(
        pool.query(
          `INSERT INTO wallet_ledger
             (client_id, seq, kind, amount_minor, balance_after_minor, actor_type, created_at)
           VALUES ($1, 1, 'signup_credit', 100, 100, 'system', '2031-02-01 03:00:00+05:00')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/no partition of relation/i);
    } finally {
      await pool.query('DROP TABLE IF EXISTS wallet_ledger_y2031m02');
    }
  });

  /**
   * P03 (db-queue-and-claim) Unit A additions - `db/src/partitions.ts`'s
   * `ensureAllPartitions()`, exercised against a far-future clock (fixed
   * 2032-01-01) so these cases never collide with whatever the real
   * current-month/current-week partitions are on the shared dev database,
   * and so the "exactly 3 monthly / 3 weekly" counts asserted below are not
   * accidentally satisfied by partitions migrations 0004/0007/0009 already
   * seeded around "now". Every partition this test creates is dropped in
   * `finally`.
   */
  it('ensure_partitions_creates_current_plus_two_months', async () => {
    const pool = await getMigratedPool();
    const fixedNow = new Date('2032-01-15T00:00:00Z');

    try {
      await ensureAllPartitions(pool, { now: () => fixedNow });

      const monthly = await pool.query<{ table_name: string; count: number }>(`
        SELECT c.relname AS table_name, count(*)::int AS count
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = ANY(ARRAY['message_jobs'::regclass, 'wallet_ledger'::regclass])
           AND c.relname LIKE '%_y2032m%'
         GROUP BY c.relname
      `);
      const monthlyNames = monthly.rows.map((row) => row.table_name).sort();
      expect(monthlyNames).toEqual(
        [
          'message_jobs_y2032m01',
          'message_jobs_y2032m02',
          'message_jobs_y2032m03',
          'wallet_ledger_y2032m01',
          'wallet_ledger_y2032m02',
          'wallet_ledger_y2032m03',
        ].sort(),
      );

      const weekly = await pool.query<{ table_name: string }>(`
        SELECT c.relname AS table_name
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'delivery_events'::regclass
           AND c.relname LIKE '%_y2032w%'
      `);
      // Weekly cadence over a 15-day span (current + 2 weeks ahead from
      // 2032-01-15) always yields exactly 3 distinct ISO weeks.
      expect(weekly.rows.length).toBe(3);
    } finally {
      await dropY2032TestPartitions(pool);
    }
  });

  it('ensure_partitions_is_idempotent_when_rerun', async () => {
    const pool = await getMigratedPool();
    const fixedNow = new Date('2032-06-15T00:00:00Z');

    try {
      await ensureAllPartitions(pool, { now: () => fixedNow });
      // Second run: must create nothing new and must not throw.
      await expect(ensureAllPartitions(pool, { now: () => fixedNow })).resolves.toBeUndefined();

      const monthlyCount = await pool.query<{ count: number }>(`
        SELECT count(*)::int AS count
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'message_jobs'::regclass
           AND c.relname LIKE '%_y2032m%'
      `);
      expect(monthlyCount.rows[0]?.count).toBe(3);
    } finally {
      await dropY2032TestPartitions(pool);
    }
  });
});
