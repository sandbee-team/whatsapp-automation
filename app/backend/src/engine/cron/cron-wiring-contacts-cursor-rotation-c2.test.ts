import { describe, expect, it } from 'vitest';
import type { CronWiringPool } from './cron-wiring.js';
import {
  listActiveClientIds,
  type ListActiveClientIdsOptions,
} from './cron-wiring-contacts-maintenance.js';

/**
 * cron-wiring-contacts-cursor-rotation-c2.test.ts (C2 hardening) - the C2
 * brief's cursor-rotation case: `listActiveClientIds` with `limit 2` over 5
 * clients should return every id exactly once across three calls, and a
 * fourth call (once the caller wraps back to the nil uuid) reproduces the
 * first page again. `listActiveClientIds` is a plain exported function
 * taking `afterId`/`limit` explicitly (no module-private cursor) - this
 * test drives the cursor itself, observing the exported function's sequence
 * directly rather than needing to reset any hidden state.
 *
 * A fake in-memory "pool" stands in for Postgres: `contacts-active-
 * clients.sql`'s own contract is `WHERE id > $after_id ORDER BY id LIMIT
 * $limit` - the fake below implements that same contract against a fixed
 * in-memory id list, since asserting the ROTATION behaviour needs no real
 * database.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Five ids, already in ascending sort order (uuidv4-shaped but
// deterministic/sortable for this test's own purposes).
const CLIENT_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005',
];

/** `connect` is never actually called by `listActiveClientIds` (query-only) - stubbed purely to satisfy `CronWiringPool`'s wider (`SingleFlightPool`-inherited) type contract. */
function makeFakePool(): CronWiringPool {
  return {
    connect(): never {
      throw new Error('makeFakePool: connect() is not exercised by listActiveClientIds');
    },
    async query<T extends Record<string, unknown>>(_sql: string, params?: unknown[]) {
      const afterId = String(params?.[0]);
      const limit = Number(params?.[1]);
      const page = CLIENT_IDS.filter((id) => id > afterId)
        .sort()
        .slice(0, limit)
        .map((client_id) => ({ client_id }) as unknown as T);
      return { rows: page };
    },
  };
}

/**
 * Drives the SAME rotating-cursor idiom `createContactsMaintenanceLoops`
 * uses internally (module-level `let cursor`, wrapping to the nil uuid once
 * a page comes back EMPTY - see that function's own doc comment), exposed
 * here for direct assertion since the loop itself is not separately
 * callable.
 */
async function rotatingWalk(
  pool: ReturnType<typeof makeFakePool>,
  limit: number,
  ticks: number,
): Promise<string[][]> {
  let cursor = NIL_UUID;
  const pages: string[][] = [];
  for (let i = 0; i < ticks; i += 1) {
    const options: ListActiveClientIdsOptions = { afterId: cursor, limit };
    let page = await listActiveClientIds(pool, options);
    if (page.length === 0) {
      // Wrap to the nil uuid and re-read once, same as
      // `createContactsMaintenanceLoops`'s own `last ?? NIL_UUID` handling
      // applied across ticks.
      cursor = NIL_UUID;
      page = await listActiveClientIds(pool, { afterId: cursor, limit });
    }
    pages.push(page);
    const last = page[page.length - 1];
    cursor = last ?? NIL_UUID;
  }
  return pages;
}

describe('listActiveClientIds rotating cursor, limit 2 over 5 clients', () => {
  it('three_calls_return_all_five_ids_exactly_once_each_the_fourth_wraps_to_the_first_two_again', async () => {
    const pool = makeFakePool();
    const pages = await rotatingWalk(pool, 2, 4);

    expect(pages[0]).toEqual([CLIENT_IDS[0], CLIENT_IDS[1]]);
    expect(pages[1]).toEqual([CLIENT_IDS[2], CLIENT_IDS[3]]);
    expect(pages[2]).toEqual([CLIENT_IDS[4]]);

    // Union of the first three pages is every id, exactly once each.
    const seen = [...pages[0]!, ...pages[1]!, ...pages[2]!];
    expect(seen).toEqual(CLIENT_IDS);
    expect(new Set(seen).size).toBe(5);

    // The fourth call: the third page (id 5 only) advanced the cursor past
    // the end, so the raw read comes back empty, the walker wraps to nil,
    // and re-reads - reproducing the FIRST page again.
    expect(pages[3]).toEqual([CLIENT_IDS[0], CLIENT_IDS[1]]);
  });
});
