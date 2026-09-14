import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { listPublicTables, countRows, type Queryable } from './run-restore-verify-checks.js';

/**
 * run-restore-snapshot-counts.ts (P26 restore-drill-verifier defect-1 fix,
 * 2026-09-07) - makes the drill's row-count check race-free by construction.
 *
 * THE BUG THIS REPLACES: `run-restore-verify.ts` used to count every table on
 * the LIVE source AFTER `pg_restore` finished, and compare that to the
 * restored copy's counts. The restored copy is a snapshot frozen at DUMP
 * time; the "source" counts were read minutes later, from a database any
 * concurrent writer keeps mutating. With any writer live the two counts can
 * never agree - drill #3 (18:30:48 IST) reported an 11-table mismatch purely
 * from this skew, not from a real restore defect.
 *
 * THE FIX: one Postgres transaction opens `BEGIN ISOLATION LEVEL REPEATABLE
 * READ; SELECT pg_export_snapshot()`, counts every table INSIDE that
 * transaction (so every count is read at the SAME MVCC snapshot), then this
 * process spawns `pg_dump --snapshot=<id>` ITSELF while the transaction is
 * still open - `pg_dump`'s own snapshot doc requires the exporting
 * transaction to still be open for its whole run. Only after `pg_dump` exits
 * does this process COMMIT (a read-only REPEATABLE READ transaction has
 * nothing to lose by committing late; SELECT-only, no writes). The dump and
 * the counts are therefore provably the same snapshot - `run-restore-
 * verify.ts` compares the RESTORED copy's counts to this file's counts
 * (`--source-counts <file>`), never to a fresh live query.
 *
 * FIX-P26-H MAJOR C (2026-09-07): the table LIST query
 * (`listPublicTables`) used to run on `pool` - a DIFFERENT connection than
 * the pinned snapshot transaction's `client`. `information_schema.tables`
 * is itself subject to MVCC snapshot isolation, so a table created or
 * dropped between the two connections' snapshots could make the list and
 * the counts disagree on which tables even exist. `countAllTablesOnClient`
 * now takes the SAME `client` the snapshot transaction opened on, so the
 * list and every count are read at the identical pinned snapshot.
 *
 * `pg_dump` is spawned with the SAME connection env the calling script
 * already set (PGHOST/PGPORT/PGUSER/PGPASSWORD via `process.env`) - never
 * credentials in argv (`restore-drill.ps1`/`.sh`'s own rule, unchanged).
 * `scripts/ops/restore-drill.ps1`/`.sh` call this step in place of raw
 * `pg_dump`, and its exit code (this process's own `process.exitCode`)
 * IS `pg_dump`'s exit code - callers keep checking one exit code, unchanged.
 */

export interface SnapshotCountsFile {
  snapshotId: string;
  countedAtIso: string;
  tables: Record<string, number>;
}

export interface RunSnapshotCountsOptions {
  /** Source (live) database connection string - the ONE connection the snapshot/count transaction runs on. */
  source: string;
  /** Where to write the `pg_dump` output (custom format, `-Fc -Z0`, matching the drill's existing invocation). */
  dumpPath: string;
  /** Where to write the `SnapshotCountsFile` JSON. */
  countsPath: string;
  /** Absolute path to the `pg_dump` binary (e.g. `C:\Program Files\PostgreSQL\17\bin\pg_dump.exe`). */
  pgDumpPath: string;
  /** The database name `pg_dump -d <name>` dumps - the source connection's own database. */
  sourceDatabase: string;
}

/**
 * Pure argv builder for the snapshot-pinned `pg_dump` invocation - no
 * credentials in argv (PGHOST/PGPORT/PGUSER/PGPASSWORD are read from `env`
 * by `pg_dump` itself), matching `-Fc -Z0` from the un-pinned invocation this
 * replaces.
 */
export function buildPgDumpArgs(opts: {
  sourceDatabase: string;
  dumpPath: string;
  snapshotId: string;
}): string[] {
  return [
    '-Fc',
    '-Z0',
    '-d',
    opts.sourceDatabase,
    '-f',
    opts.dumpPath,
    `--snapshot=${opts.snapshotId}`,
  ];
}

/**
 * Lists every `public` table AND counts each one - both on the SAME `client`
 * (MAJOR C fix, see this file's own header): a `PoolClient` from
 * `pool.connect()` has the same `.query` shape `listPublicTables`/`countRows`
 * are typed for (both from `pg`), so the client already inside the pinned
 * snapshot transaction is accepted here unchanged. Exported for its own unit
 * test (a fake client recording which connection each query used).
 */
export async function countAllTablesOnClient(client: Queryable): Promise<Record<string, number>> {
  const tableNames = await listPublicTables(client);
  const tables: Record<string, number> = {};
  for (const name of tableNames) {
    tables[name] = await countRows(client, name);
  }
  return tables;
}

function spawnPgDump(pgDumpPath: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pgDumpPath, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * Opens the pinned snapshot transaction, counts every table, spawns
 * `pg_dump --snapshot=<id>` while the transaction is STILL OPEN, commits,
 * and returns `pg_dump`'s own exit code. Writes the counts file before
 * returning so a non-zero `pg_dump` exit still leaves the counts on disk for
 * diagnosis.
 */
export async function runSnapshotCounts(opts: RunSnapshotCountsOptions): Promise<number> {
  const pool = createPool({
    connectionString: opts.source,
    applicationName: 'restore-drill-snapshot-counts',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      const snapshotResult = await client.query<{ pg_export_snapshot: string }>(
        'SELECT pg_export_snapshot()',
      );
      const snapshotId = snapshotResult.rows[0]?.pg_export_snapshot;
      if (snapshotId === undefined) {
        throw new Error('runSnapshotCounts: pg_export_snapshot() returned no snapshot id');
      }

      const tables = await countAllTablesOnClient(client);
      const countedAtIso = new Date().toISOString();

      const dumpArgs = buildPgDumpArgs({
        sourceDatabase: opts.sourceDatabase,
        dumpPath: opts.dumpPath,
        snapshotId,
      });
      const exitCode = await spawnPgDump(opts.pgDumpPath, dumpArgs);

      const countsFile: SnapshotCountsFile = { snapshotId, countedAtIso, tables };
      writeFileSync(opts.countsPath, JSON.stringify(countsFile, null, 2), 'utf8');

      return exitCode;
    } finally {
      await client.query('COMMIT');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

const USAGE =
  'usage: run-restore-snapshot-counts.ts --source <url> --source-database <name> ' +
  '--dump <path> --counts-out <counts.json> --pg-dump-path <path-to-pg_dump>';

function parseArgs(argv: string[]): RunSnapshotCountsOptions {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== undefined && arg.startsWith('--')) {
      const val = argv[i + 1];
      if (val !== undefined) {
        map.set(arg.slice(2), val);
        i += 1;
      }
    }
  }
  const required = (key: string): string => {
    const value = map.get(key);
    if (value === undefined) {
      throw new Error(`run-restore-snapshot-counts: missing required --${key}\n${USAGE}`);
    }
    return value;
  };
  return {
    source: required('source'),
    sourceDatabase: required('source-database'),
    dumpPath: required('dump'),
    countsPath: required('counts-out'),
    pgDumpPath: required('pg-dump-path'),
  };
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  if (process.argv.includes('--help')) {
    console.log(USAGE);
  } else {
    runSnapshotCounts(parseArgs(process.argv.slice(2))).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        console.error(describeError(err));
        process.exitCode = 1;
      },
    );
  }
}
