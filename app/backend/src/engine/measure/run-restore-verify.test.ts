import { describe, expect, it } from 'vitest';
import { buildTableComparisons } from './run-restore-verify.js';

/**
 * run-restore-verify.test.ts (P26 restore-drill-verifier defect-1 fix,
 * 2026-09-07) - `buildTableComparisons`'s own unit test: proves restored
 * counts are compared to the SNAPSHOT counts file's numbers, never to a
 * fresh live query - the fix for the race that made drill #3's 11-table
 * mismatch inevitable (source counts read live, minutes after the dump,
 * while a writer kept moving). Does not reach `@wp/server-kit` (only
 * `@wp/db` types and `node:fs`/`node:path`/`node:url` at the top of the
 * module under test - `buildTableComparisons` itself touches neither), so
 * no `stub-wp-server-kit-env` import is needed here.
 */

describe('buildTableComparisons', () => {
  it('compares restored counts against the snapshot file, not a live query', () => {
    const sourceCounts = { clients: 12, message_jobs: 200_039 };
    const restoredCountsByTable = new Map([
      ['clients', 12],
      ['message_jobs', 200_039],
    ]);

    const tables = buildTableComparisons(sourceCounts, restoredCountsByTable);

    expect(tables).toEqual([
      { name: 'clients', sourceRows: 12, restoredRows: 12 },
      { name: 'message_jobs', sourceRows: 200_039, restoredRows: 200_039 },
    ]);
  });

  it('a table missing from the restored copy is a real gap (restoredRows: 0), not skipped', () => {
    const sourceCounts = { send_attempts: 3_472 };
    const restoredCountsByTable = new Map<string, number>();

    const tables = buildTableComparisons(sourceCounts, restoredCountsByTable);

    expect(tables).toEqual([{ name: 'send_attempts', sourceRows: 3_472, restoredRows: 0 }]);
  });

  it('a snapshot taken while a writer was live still matches the restore (the race this fixes)', () => {
    // The snapshot file's counts were taken INSIDE the same transaction
    // pg_dump ran under, so they equal the restored copy exactly even
    // though a writer kept inserting into the LIVE database afterwards -
    // the old bug compared against a later live count (62 -> higher) and
    // reported a false mismatch.
    const sourceCounts = { delivery_events_y2026w37: 62 };
    const restoredCountsByTable = new Map([['delivery_events_y2026w37', 62]]);

    const tables = buildTableComparisons(sourceCounts, restoredCountsByTable);

    expect(tables).toEqual([
      { name: 'delivery_events_y2026w37', sourceRows: 62, restoredRows: 62 },
    ]);
  });
});
