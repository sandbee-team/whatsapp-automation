import { describe, expect, it } from 'vitest';
import type { createPool } from '@wp/db';
import { collectDuplicateAckedAttemptCount } from './run-pacing-collect.js';

/**
 * run-pacing-collect.test.ts (FIX-P26-H MAJOR B, 2026-09-07) -
 * `collectDuplicateAckedAttemptCount`'s own unit test. A fake pool records
 * the exact query text and params, so this proves the collector queries
 * `send_attempts` (state = 'acked', grouped by `message_job_id`,
 * `client_id = ANY($1)`-scoped per invariant 4) rather than
 * `message_wa_ids` (the old `collectDuplicateWaIdCount`, which could never
 * observe a real duplicate because `message_wa_ids_message_id_uq`
 * (migration 0026) makes a second row for the same `(client_id, instance_id,
 * message_id)` impossible to insert at all - the write in
 * `engine/queue/result.ts#resolveAck` has no `ON CONFLICT`, so it raises
 * `23505` and rolls back instead of landing a duplicate row). Does not reach
 * `@wp/server-kit` (only `@wp/db`'s `createPool` TYPE), so no
 * `stub-wp-server-kit-env` import is needed here - same reasoning as the
 * sibling `measure-enqueue.test.ts` header.
 */

interface RecordedQuery {
  text: string;
  values: unknown[];
}

function fakePool(rows: { count: string }[]): {
  pool: ReturnType<typeof createPool>;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (text: string, values: unknown[]) => {
      queries.push({ text, values });
      return { rows };
    },
  } as unknown as ReturnType<typeof createPool>;
  return { pool, queries };
}

describe('collectDuplicateAckedAttemptCount', () => {
  it('queries send_attempts for acked attempts per job, tenant-scoped, never message_wa_ids', async () => {
    const { pool, queries } = fakePool([{ count: '2' }]);

    const count = await collectDuplicateAckedAttemptCount(pool, ['client-a', 'client-b']);

    expect(count).toBe(2);
    expect(queries).toHaveLength(1);
    const query = queries[0];
    expect(query).toBeDefined();
    expect(query?.text).toContain('send_attempts');
    expect(query?.text).toContain("state = 'acked'");
    expect(query?.text).toContain('message_job_id');
    expect(query?.text).toContain('client_id = ANY($1)');
    expect(query?.text).not.toContain('message_wa_ids');
    expect(query?.values).toEqual([['client-a', 'client-b']]);
  });

  it('returns 0 without querying when clientIds is empty (never a table-wide scan)', async () => {
    const { pool, queries } = fakePool([{ count: '0' }]);

    const count = await collectDuplicateAckedAttemptCount(pool, []);

    expect(count).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
