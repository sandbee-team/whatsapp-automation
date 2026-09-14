import { describe, expect, it } from 'vitest';
import { buildPgDumpArgs, countAllTablesOnClient } from './run-restore-snapshot-counts.js';
import type { Queryable } from './run-restore-verify-checks.js';

/**
 * run-restore-snapshot-counts.test.ts (P26 restore-drill-verifier defect-1
 * fix, 2026-09-07; FIX-P26-H MAJOR C, 2026-09-07) - `buildPgDumpArgs`'s own
 * unit test: proves the snapshot id is threaded into `pg_dump`'s argv as
 * `--snapshot=<id>` alongside the SAME `-Fc -Z0 -d <db> -f <dump>` flags the
 * un-pinned invocation used, and that no credential ever appears in argv
 * (PGHOST/PGPORT/PGUSER/PGPASSWORD are read from `env` by `pg_dump` itself -
 * see the module's own doc comment). Also proves (MAJOR C) that the public
 * table LIST query and every per-table COUNT run on the SAME connection
 * object passed in - `runSnapshotCounts` must pin both to the single
 * `pool.connect()` client already inside the `REPEATABLE READ` snapshot
 * transaction, never a separate `pool.query` on a different connection (that
 * would read the table list from a different, unpinned MVCC snapshot).
 * Does not reach `@wp/server-kit` (only `node:child_process`/`node:fs`/
 * `node:path`/`node:url` and `@wp/db` types at the top of the module under
 * test - `runSnapshotCounts` itself is not exercised here, only the pure
 * argv builder and the client-scoped counting helper, so no real
 * Postgres/`pg_dump` is needed), so no `stub-wp-server-kit-env` import is
 * needed here.
 */

describe('buildPgDumpArgs', () => {
  it('threads the exported snapshot id into --snapshot, keeping -Fc -Z0 unchanged', () => {
    const args = buildPgDumpArgs({
      sourceDatabase: 'wp',
      dumpPath: 'C:\\Temp\\wp-restore-drill-20260907-183000.dump',
      snapshotId: '00000003-0000001A-1',
    });

    expect(args).toEqual([
      '-Fc',
      '-Z0',
      '-d',
      'wp',
      '-f',
      'C:\\Temp\\wp-restore-drill-20260907-183000.dump',
      '--snapshot=00000003-0000001A-1',
    ]);
  });

  it('never places a credential in argv', () => {
    const args = buildPgDumpArgs({
      sourceDatabase: 'wp',
      dumpPath: 'C:\\Temp\\dump',
      snapshotId: 'snap-1',
    });

    expect(args.join(' ')).not.toMatch(/PGPASSWORD|password|@/i);
  });
});

describe('countAllTablesOnClient (MAJOR C - single-connection snapshot pinning)', () => {
  it('runs the table-list query AND every count query on the same passed-in client, never a second connection', async () => {
    const calls: string[] = [];
    const fakeClient: Queryable = {
      query: async <T>(text: string): Promise<{ rows: T[] }> => {
        calls.push(text);
        if (text.includes('information_schema.tables')) {
          return { rows: [{ table_name: 'clients' }, { table_name: 'message_jobs' }] as T[] };
        }
        return { rows: [{ count: '3' }] as T[] };
      },
    };

    const tables = await countAllTablesOnClient(fakeClient);

    expect(tables).toEqual({ clients: 3, message_jobs: 3 });
    // Exactly 3 calls (1 list + 2 counts), ALL on `fakeClient` - a second
    // connection would show up as a call this fake never recorded.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('information_schema.tables');
    expect(calls[1]).toContain('"clients"');
    expect(calls[2]).toContain('"message_jobs"');
  });
});
