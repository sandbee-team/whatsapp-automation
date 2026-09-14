import { createPool } from '@wp/db';
import type {
  PgBouncerSnapshot,
  PgLoadBaseline,
  PgSnapshot,
} from '../../../../../scripts/measure/pg-load.js';

/**
 * run-pg-load-snapshots.ts (P26 U4, step 4) - the REAL SQL snapshot readers
 * for `run-pg-load.ts`, split out for the 300-line cap (established idiom -
 * `session-worker-discovery-wiring.ts`). Every query here was verified
 * interactively against the dev Postgres + PgBouncer admin database before
 * being written (see this unit's own report for the exact `SHOW POOLS`/
 * `SHOW CONFIG` column names observed).
 */

/** Sum of `pg_stat_statements.calls` for THIS database only (never the whole cluster) - requires `pg_stat_statements` in `shared_preload_libraries` (already enabled on the dev box, U2a). */
export async function readStatementsTotal(pool: ReturnType<typeof createPool>): Promise<number> {
  const result = await pool.query<{ sum: string | null }>(
    `SELECT sum(calls) AS sum FROM pg_stat_statements
     WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
  return Number(result.rows[0]?.sum ?? 0);
}

/** `pg_total_relation_size` (heap + indexes + toast) per base table in `public` - the same shape the load-model measures durable bytes/send against. */
export async function readRelationSizesBytes(
  pool: ReturnType<typeof createPool>,
): Promise<Record<string, number>> {
  const result = await pool.query<{ table_name: string; size: string }>(
    `SELECT table_name, pg_total_relation_size(quote_ident(table_name))::bigint AS size
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    out[row.table_name] = Number(row.size);
  }
  return out;
}

/** WAL position converted to an absolute byte offset via `pg_wal_lsn_diff` against `'0/0'` - a delta of two snapshots is the bytes written in the window. */
export async function readWalBytes(pool: ReturnType<typeof createPool>): Promise<number> {
  const result = await pool.query<{ diff: string }>(
    `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint AS diff`,
  );
  return Number(result.rows[0]?.diff ?? 0);
}

/** `sum(consumed_count)` across `pacing_ledger` rows for the probe instances - cross-checked against ROW-counted observed sends (invariant 7: never trust a harness tally alone). */
export async function readPacingConsumed(
  pool: ReturnType<typeof createPool>,
  instanceIds: string[],
  clientIds: string[],
): Promise<number> {
  if (instanceIds.length === 0) return 0;
  const result = await pool.query<{ sum: string | null }>(
    `SELECT coalesce(sum(consumed_count), 0)::bigint AS sum FROM pacing_ledger
      WHERE instance_id = ANY($1) AND client_id = ANY($2)`,
    [instanceIds, clientIds],
  );
  return Number(result.rows[0]?.sum ?? 0);
}

/** Counts `message_jobs` rows for the probe clients that reached a terminal state ('sent' or 'failed') - the ONLY source of `sends.observed` (never a harness enqueue tally, invariant 7). */
export async function readTerminalJobCount(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<number> {
  if (clientIds.length === 0) return 0;
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::bigint AS count FROM message_jobs WHERE client_id = ANY($1) AND status IN ('sent', 'failed')`,
    [clientIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Counts `message_jobs` rows for the probe clients still queued/processing - used only to poll for drain, never for `sends.observed`. */
export async function readPendingJobCount(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<number> {
  if (clientIds.length === 0) return 0;
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::bigint AS count FROM message_jobs WHERE client_id = ANY($1) AND status IN ('created', 'queued', 'processing')`,
    [clientIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** FIX-P26-E: a scoped, read-only sample of at most 20 pending jobs for the probe clients (tenant-scoped `client_id = ANY($1)`, invariant 4) - attached to `DrainTimeoutError` so a timeout names WHICH jobs stalled instead of only a count. */
export async function readPendingJobSample(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<{ id: string; status: string; attempts: number }[]> {
  if (clientIds.length === 0) return [];
  const result = await pool.query<{ id: string; status: string; attempts: number }>(
    `SELECT id, status, attempts FROM message_jobs
      WHERE client_id = ANY($1) AND status IN ('created', 'queued', 'processing')
      ORDER BY id LIMIT 20`,
    [clientIds],
  );
  return result.rows;
}

/** `message_jobs.status` -> row count for the probe clients - the Harness gap fix: lets a reader see `processing`/`needs_reconcile` residue directly, never inferred from a harness tally. */
export async function readJobStatusHistogram(
  pool: ReturnType<typeof createPool>,
  clientIds: string[],
): Promise<Record<string, number>> {
  if (clientIds.length === 0) return {};
  const result = await pool.query<{ status: string; count: string }>(
    `SELECT status, count(*)::bigint AS count FROM message_jobs WHERE client_id = ANY($1) GROUP BY status`,
    [clientIds],
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row.status] = Number(row.count);
  return out;
}

/**
 * Samples an IDLE baseline (MAJOR 5): takes two snapshots `seconds` apart
 * with the fleet up but not yet driving sends, and returns the per-second
 * RATES those two snapshots imply. `seconds <= 0` returns `null` immediately
 * (the `--baseline-seconds 0` explicit-skip path) rather than sleeping for a
 * non-positive duration.
 */
export async function sampleBaseline(
  deps: Parameters<typeof takeSnapshot>[0] & {
    seconds: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<PgLoadBaseline | null> {
  if (deps.seconds <= 0) return null;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const before = await takeSnapshot(deps);
  await sleep(deps.seconds * 1000);
  const after = await takeSnapshot(deps);
  const elapsedSeconds = (after.atMs - before.atMs) / 1000;
  let relationTotalDelta = 0;
  const tableNames = new Set([
    ...Object.keys(before.relationSizesBytes),
    ...Object.keys(after.relationSizesBytes),
  ]);
  for (const name of tableNames) {
    relationTotalDelta +=
      (after.relationSizesBytes[name] ?? 0) - (before.relationSizesBytes[name] ?? 0);
  }
  return {
    statementsPerSec: (after.statementsTotal - before.statementsTotal) / elapsedSeconds,
    walBytesPerSec: (after.walBytes - before.walBytes) / elapsedSeconds,
    relationBytesPerSec: relationTotalDelta / elapsedSeconds,
    seconds: elapsedSeconds,
  };
}

/**
 * Reads `SHOW POOLS` + `SHOW CONFIG` from a SEPARATE connection to the
 * `pgbouncer` admin database. Verified column names (edoburu/pgbouncer
 * v1.24.1-p1, this repo's dev stack): `SHOW POOLS` returns `database, user,
 * cl_active, cl_waiting, ..., pool_mode, ...` (one row per database/user
 * pair - we read the row whose `database` matches our target db name);
 * `SHOW CONFIG` returns `key, value, default, changeable` (one row per
 * setting - we read `default_pool_size`/`max_client_conn` by `key`).
 * Returns `null` (never a guess) if the connection or either query fails.
 */
export async function readPgBouncerSnapshot(
  adminConnectionString: string,
  targetDatabase: string,
): Promise<PgBouncerSnapshot | null> {
  const pool = createPool({
    connectionString: adminConnectionString,
    applicationName: 'pg-load-measure-admin',
    max: 1,
  });
  try {
    const pools = await pool.query<{
      database: string;
      pool_mode: string;
      cl_waiting: string;
      maxwait_us: string;
    }>('SHOW POOLS');
    const config = await pool.query<{ key: string; value: string }>('SHOW CONFIG');

    const poolRow = pools.rows.find((r) => r.database === targetDatabase);
    if (!poolRow) return null;

    const configByKey = new Map(config.rows.map((r) => [r.key, r.value]));

    return {
      poolMode: poolRow.pool_mode,
      defaultPoolSize: numberOrNull(configByKey.get('default_pool_size')),
      maxClientConn: numberOrNull(configByKey.get('max_client_conn')),
      clWaiting: numberOrNull(poolRow.cl_waiting),
      avgWaitUs: numberOrNull(poolRow.maxwait_us),
    };
  } catch {
    return null;
  } finally {
    await pool.end();
  }
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Takes one full snapshot (statements + relation sizes + WAL + PgBouncer + pacing) at the current instant. */
export async function takeSnapshot(deps: {
  pool: ReturnType<typeof createPool>;
  pgBouncerAdminUrl: string | null;
  targetDatabase: string;
  instanceIds: string[];
  /** The fleet's own seeded tenants - every pacing read is `client_id`-scoped to these (invariant 4). */
  clientIds: string[];
  now: () => number;
}): Promise<PgSnapshot> {
  const [statementsTotal, relationSizesBytes, walBytes, pacingConsumed, pgBouncer] =
    await Promise.all([
      readStatementsTotal(deps.pool),
      readRelationSizesBytes(deps.pool),
      readWalBytes(deps.pool),
      readPacingConsumed(deps.pool, deps.instanceIds, deps.clientIds),
      deps.pgBouncerAdminUrl
        ? readPgBouncerSnapshot(deps.pgBouncerAdminUrl, deps.targetDatabase)
        : Promise.resolve(null),
    ]);

  return {
    atMs: deps.now(),
    statementsTotal,
    relationSizesBytes,
    walBytes,
    pgBouncer,
    pacingConsumed,
  };
}
