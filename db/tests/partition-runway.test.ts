import { afterAll, describe, expect, it } from 'vitest';
import { ensureAllPartitions } from '../src/index.js';
import { MONTHLY_PARTITIONED_TABLES, WEEKLY_PARTITIONED_TABLES } from '../src/partitions.js';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';

/**
 * partition-runway.test.ts (2026-09-14)
 *
 * THE DEFECT THIS PINS: `ensureAllPartitions` existed but had ZERO production
 * callers - only `db/src/index.ts`'s export and test helpers. Each migration
 * seeds current + 2 periods at APPLY time, and for the WEEKLY table
 * (`delivery_events`) that is about 21 days. An INSERT past the last
 * partition fails outright, so a freshly deployed system would have started
 * failing its send-result write roughly three weeks after launch, with
 * nothing in the running system able to extend the runway.
 *
 * `ROLE=migrate` now calls it on every deploy with `periodsAhead: 6`. It runs
 * there rather than in `cron` because both `wp_ensure_*_partition` functions
 * have EXECUTE revoked from everyone but their owner - deliberately, to keep
 * partition DDL off the request-time grant surface. Verified directly: under
 * `SET LOCAL ROLE wp_scheduler` the call fails with "permission denied for
 * function wp_ensure_month_partition".
 *
 * These tests assert the RUNWAY, not a literal partition name: the point is
 * "how far ahead can we insert", which is what actually breaks.
 */

const FIXED_NOW = new Date('2033-03-10T00:00:00Z');
const PERIODS_AHEAD = 6;

afterAll(async () => {
  const pool = await getMigratedPool();
  // Drop only what this test created - every partition it makes is in 2033.
  for (const table of [...MONTHLY_PARTITIONED_TABLES, ...WEEKLY_PARTITIONED_TABLES]) {
    const children = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_catalog.pg_inherits i
         JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = $1::regclass AND c.relname LIKE '%2033%'`,
      [table],
    );
    for (const row of children.rows) {
      await pool.query(`DROP TABLE IF EXISTS ${row.relname}`);
    }
  }
  await closeMigratedPool();
});

describe('partition runway (the migrate-role maintenance call)', () => {
  it('every_partitioned_table_gets_current_plus_six_periods', async () => {
    const pool = await getMigratedPool();
    await ensureAllPartitions(pool, { now: () => FIXED_NOW, periodsAhead: PERIODS_AHEAD });

    // Asserted for EVERY table in both lists, derived from the exported
    // constants rather than hand-listed - a newly partitioned table is
    // covered automatically instead of being silently forgotten.
    for (const table of [...MONTHLY_PARTITIONED_TABLES, ...WEEKLY_PARTITIONED_TABLES]) {
      const created = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM pg_catalog.pg_inherits i
           JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = $1::regclass AND c.relname LIKE '%2033%'`,
        [table],
      );
      // current + 6 = 7 periods, all inside 2033 for this fixed clock.
      expect({ table, count: created.rows[0]?.count }).toEqual({ table, count: PERIODS_AHEAD + 1 });
    }
  });

  it('the_weekly_table_has_more_than_a_month_of_runway_not_the_21_days_the_default_gives', async () => {
    const pool = await getMigratedPool();
    await ensureAllPartitions(pool, { now: () => FIXED_NOW, periodsAhead: PERIODS_AHEAD });

    // `delivery_events` is the one that bites first: weekly periods mean the
    // shipped default of 2 gives ~21 days. This asserts the real property -
    // the newest partition must accept a row well over a month out - rather
    // than a partition count, which is what would actually have failed.
    // Read every bound and take the newest in JS - simpler and far less
    // brittle than parsing `FOR VALUES FROM ('…') TO ('…')` in SQL.
    const bounds = await pool.query<{ bound: string }>(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
         FROM pg_catalog.pg_inherits i
         JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'delivery_events'::regclass`,
      [],
    );

    const upperBounds = bounds.rows
      .map((row) => /TO \('([^']+)'\)/.exec(row.bound)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value.replace(' ', 'T').replace('+00', 'Z')).getTime())
      .filter((ms) => Number.isFinite(ms));

    expect(upperBounds.length).toBeGreaterThan(0);
    const daysOfRunway = Math.round((Math.max(...upperBounds) - FIXED_NOW.getTime()) / 86_400_000);
    expect(daysOfRunway).toBeGreaterThan(35);
  });
});
