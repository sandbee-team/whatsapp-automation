import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, ensureAllPartitions } from '@wp/db';
import { runMigrations } from '@wp/db/migrate';
import { z } from 'zod';

/**
 * ROLE=migrate entrypoint: runs the forward-only migration runner
 * (`@wp/db`'s `runMigrations`) against the repo's `db/migrations` directory.
 * This file is the process boundary that reads `DATABASE_URL` - `db/src/**`
 * never reads `process.env` directly (see `db/src/migrate.ts`'s doc
 * comment).
 *
 * `@wp/server-kit/config` (P01) parses one fixed schema for server-kit's own
 * env vars (`WP_ENV`, `WP_LOG_LEVEL`, ...) and does not cover `DATABASE_URL`,
 * so this role validates its own minimal `{ DATABASE_URL }` schema locally
 * with the same library (zod) and the same parse-once, never-echo-the-value
 * idiom as that loader, rather than reading `process.env.DATABASE_URL`
 * inline.
 */
const roleConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
});

function loadRoleConfig(env: NodeJS.ProcessEnv): { DATABASE_URL: string } {
  const result = roleConfigSchema.safeParse(env);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid or missing config env var(s): ${keys.join(', ')}`);
  }
  return result.data;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// app/backend/src/roles -> app/backend/src -> app/backend -> app -> repo root
const MIGRATIONS_DIR = path.resolve(HERE, '..', '..', '..', '..', 'db', 'migrations');

/**
 * How many periods beyond the current one to seed. 6 gives six months of
 * monthly headroom and six weeks of weekly headroom, so the deploy cadence
 * would have to lapse for over a month before anything runs out.
 *
 * Deliberately larger than `ensureAllPartitions`'s own default of 2: that
 * default matches what each migration seeds at apply time, which for the
 * WEEKLY table (`delivery_events`) is only ~21 days of runway.
 */
const PARTITION_PERIODS_AHEAD = 6;

async function main(): Promise<void> {
  const { DATABASE_URL } = loadRoleConfig(process.env);

  const result = await runMigrations({
    databaseUrl: DATABASE_URL,
    migrationsDir: MIGRATIONS_DIR,
    log: (line) => console.log(line),
  });

  console.log(
    `Migrate: applied ${result.applied.length} migration(s), ${result.skippedCount} already up to date.`,
  );

  // PARTITION MAINTENANCE (added 2026-09-14 - this had NO production caller).
  //
  // `message_jobs`, `wallet_ledger`, `audit_logs` and `wallet_charge_guards`
  // are monthly-partitioned; `delivery_events` is WEEKLY. Each migration
  // seeds only current + 2 periods at apply time, so a fresh deploy shipped
  // with roughly 21 days of `delivery_events` runway and nothing that would
  // ever extend it: an INSERT past the last partition fails outright, which
  // would have broken the send-result write about three weeks after launch.
  //
  // It runs HERE, not in `cron`, because the two underlying functions have
  // EXECUTE revoked from everyone but their owner - by design, so partition
  // DDL is off the request-time grant surface. Verified: under
  // `SET LOCAL ROLE wp_scheduler` the call fails with "permission denied for
  // function wp_ensure_month_partition". The migrate role already connects
  // with the privileges this needs and already runs on every deploy.
  //
  // Idempotent by construction (both `wp_ensure_*_partition` functions are),
  // so re-running a deploy creates nothing new.
  const pool = createPool({ connectionString: DATABASE_URL, applicationName: 'wp-migrate' });
  try {
    await ensureAllPartitions(pool, { periodsAhead: PARTITION_PERIODS_AHEAD });
    console.log(
      `Migrate: partitions ensured for the current + ${String(PARTITION_PERIODS_AHEAD)} periods.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${name}: ${message}`);
  process.exit(1);
});
