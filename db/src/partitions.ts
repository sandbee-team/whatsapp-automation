import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/**
 * P03 step 1/3 - the re-runnable partition-maintenance helper. Reads its own
 * SQL directly from `db/queries/ensure-partitions.sql` (no shared
 * query-loader module exists yet in this package - `db/src/queries.ts`
 * arrives with P03 Unit B's `claim-jobs.sql` loader, a parallel work unit).
 *
 * The two underlying Postgres functions this calls
 * (`wp_ensure_month_partition` - migration 0003, `wp_ensure_week_partition` -
 * migration 0009) both have EXECUTE revoked from PUBLIC and granted to no
 * one - owner (`wp_migrator`) only, by design (carried P02 requirement,
 * reviewer N14). `ensureAllPartitions` is therefore a maintenance/ops
 * routine: its caller MUST supply a `wp_migrator`-privileged connection (or,
 * in dev/test, the superuser connection the shared pool already uses) - it
 * is never part of the wp_app/wp_scheduler request-time grant surface.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENSURE_PARTITIONS_SQL_PATH = path.resolve(HERE, '..', 'queries', 'ensure-partitions.sql');

/**
 * Tables carrying a MONTHLY `created_at` partition, maintained via
 * `wp_ensure_month_partition`. `message_jobs` is this phase's own table;
 * `wallet_ledger` is P02's - carried into this helper per reviewer N14
 * (migration 0004 seeded only current+2 months at migration-apply time, with
 * no re-runnable maintenance path until this module existed). `audit_logs`
 * is P04a's (migration 0013, same seeded-3-months pattern). `wallet_charge_
 * guards` is P18's (migration 0051) - it also seeds the PREVIOUS month at
 * migration-apply time (a job created late last month can legitimately be
 * charged/repaired this month), but this re-runnable helper only ever
 * ensures the current + `periodsAhead` months forward, same as every other
 * table here.
 */
export const MONTHLY_PARTITIONED_TABLES = [
  'message_jobs',
  'wallet_ledger',
  'audit_logs',
  'wallet_charge_guards',
] as const;

/** Tables carrying a WEEKLY `created_at` partition, maintained via `wp_ensure_week_partition`. */
export const WEEKLY_PARTITIONED_TABLES = ['delivery_events'] as const;

export interface EnsurePartitionsOptions {
  /**
   * How many additional periods (months for monthly tables, weeks for
   * weekly tables) beyond the current one to seed. Default 2 (current + 2
   * ahead = 3 total), matching every migration in this phase's own seeding
   * (0004/0007/0009).
   */
  periodsAhead?: number;
  /** Injectable clock for tests - defaults to `() => new Date()`. No sleeps, no ambient Date.now() reliance. */
  now?: () => Date;
}

interface NamedStatements {
  ensureMonthlyPartition: string;
  ensureWeeklyPartition: string;
}

const REQUIRED_STATEMENT_NAMES: ReadonlyArray<keyof NamedStatements> = [
  'ensureMonthlyPartition',
  'ensureWeeklyPartition',
];

let cachedStatements: NamedStatements | undefined;

/** Parses the `-- name: <label>` sections out of `ensure-partitions.sql`. */
function parseNamedStatements(raw: string): NamedStatements {
  const sections = raw.split(/^-- name: (\w+)\s*$/m);
  const statements: Partial<Record<string, string>> = {};

  // sections[0] is the leading file-header comment block; afterwards the
  // array alternates [name, body, name, body, ...].
  for (let i = 1; i < sections.length; i += 2) {
    const name = sections[i]?.trim();
    const body = sections[i + 1]?.trim();
    if (name && body) {
      statements[name] = body;
    }
  }

  for (const name of REQUIRED_STATEMENT_NAMES) {
    if (!statements[name]) {
      throw new Error(
        `db/queries/ensure-partitions.sql is missing the required "-- name: ${name}" statement`,
      );
    }
  }

  return statements as unknown as NamedStatements;
}

async function loadStatements(): Promise<NamedStatements> {
  if (!cachedStatements) {
    const raw = await readFile(ENSURE_PARTITIONS_SQL_PATH, 'utf8');
    cachedStatements = parseNamedStatements(raw);
  }
  return cachedStatements;
}

/** `[0, 1, ..., periodsAhead]` - the current period plus every one requested ahead of it. */
function periodOffsets(periodsAhead: number): number[] {
  return Array.from({ length: periodsAhead + 1 }, (_, index) => index);
}

/** UTC first-of-month date, `monthsAhead` months after `base`. */
function monthTarget(base: Date, monthsAhead: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthsAhead, 1));
}

/** UTC date `weeksAhead * 7` days after `base` - the underlying function truncates to the ISO week (Monday) itself. */
function weekTarget(base: Date, weeksAhead: number): Date {
  return new Date(base.getTime() + weeksAhead * 7 * 24 * 60 * 60 * 1000);
}

/**
 * Ensures the current + `periodsAhead` monthly/weekly partitions exist for
 * every table in `MONTHLY_PARTITIONED_TABLES` / `WEEKLY_PARTITIONED_TABLES`.
 * Idempotent: a second call (even with the same clock) creates nothing new
 * and never throws - the underlying `wp_ensure_*_partition` functions are
 * themselves idempotent (see migrations 0003/0009), and this function adds
 * no additional state of its own.
 */
export async function ensureAllPartitions(
  pool: pg.Pool | pg.PoolClient,
  options: EnsurePartitionsOptions = {},
): Promise<void> {
  const periodsAhead = options.periodsAhead ?? 2;
  const now = options.now ?? ((): Date => new Date());
  const statements = await loadStatements();
  const base = now();

  for (const table of MONTHLY_PARTITIONED_TABLES) {
    for (const offset of periodOffsets(periodsAhead)) {
      await pool.query(statements.ensureMonthlyPartition, [table, monthTarget(base, offset)]);
    }
  }

  for (const table of WEEKLY_PARTITIONED_TABLES) {
    for (const offset of periodOffsets(periodsAhead)) {
      await pool.query(statements.ensureWeeklyPartition, [table, weekTarget(base, offset)]);
    }
  }
}
