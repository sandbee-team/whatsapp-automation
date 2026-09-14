import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { platformRead, type StaffCtx } from './platform-read.js';
import { createTestAdminPool } from './__test-support__/admin-test-support.js';

/**
 * platform-read-c2.integration.test.ts (P28 C2 hardening) - the CONCURRENT
 * half of `platformRead`'s audit guarantee. The existing suite
 * (`platform-read.integration.test.ts`) proves ONE read's audit row commits/
 * rolls back with it; this proves the SAME thing holds under 5 simultaneous
 * reads with DISTINCT `request_id`s (never a sampled/observed race outcome -
 * each row is looked up by its own `request_id`, a DB-unique key per call),
 * and that a throwing read among live siblings leaves zero rows for ITS OWN
 * `request_id` while the siblings' rows are unaffected.
 */

const pool = createTestAdminPool();
const REGISTERED_KEY = 'admin/backend/src/modules/clients/clients.read.ts:listClients';
const probeRequestIds: string[] = [];

afterAll(async () => {
  if (probeRequestIds.length > 0) {
    await pool.query('DELETE FROM audit_logs WHERE request_id = ANY($1)', [probeRequestIds]);
  }
  await pool.end();
});

function ctxFor(staffId: string, requestId: string): StaffCtx {
  probeRequestIds.push(requestId);
  return { staffId, requestId, ip: '127.0.0.1' };
}

async function auditRowFor(
  requestId: string,
): Promise<{ metadata: { query?: string }; request_id: string } | undefined> {
  const result = await pool.query<{ metadata: { query?: string }; request_id: string }>(
    `SELECT metadata, request_id FROM audit_logs WHERE request_id = $1`,
    [requestId],
  );
  return result.rows[0];
}

describe('platformRead concurrency (P28 C2)', () => {
  it('five_parallel_reads_produce_five_audit_rows_with_distinct_request_ids_each_matching_its_own_query_key', async () => {
    const staffId = randomUUID();
    const calls = Array.from({ length: 5 }, (_, i) => ({
      requestId: `c2-parallel-${randomUUID()}`,
      reason: `parallel platform-read probe #${i}`,
    }));

    await Promise.all(
      calls.map((call) =>
        platformRead(
          { pool },
          ctxFor(staffId, call.requestId),
          { key: REGISTERED_KEY, reason: call.reason },
          async () => ({ ok: true }),
        ),
      ),
    );

    const rows = await Promise.all(calls.map((call) => auditRowFor(call.requestId)));
    // Every one of the 5 calls left EXACTLY its own row (never zero, never
    // shared with a sibling's request_id - the DB unique-per-call identity
    // is the invariant, not "5 rows landed somewhere").
    for (const [index, row] of rows.entries()) {
      expect(row).toBeDefined();
      expect(row?.request_id).toBe(calls[index]!.requestId);
      expect(row?.metadata.query).toBe(REGISTERED_KEY);
    }
  });

  it('a_throwing_read_among_live_siblings_leaves_zero_rows_for_its_own_request_id_while_siblings_commit', async () => {
    const staffId = randomUUID();
    const goodA = { requestId: `c2-sibling-good-a-${randomUUID()}` };
    const bad = { requestId: `c2-sibling-bad-${randomUUID()}` };
    const goodB = { requestId: `c2-sibling-good-b-${randomUUID()}` };

    const results = await Promise.allSettled([
      platformRead(
        { pool },
        ctxFor(staffId, goodA.requestId),
        { key: REGISTERED_KEY, reason: 'sibling A, must commit' },
        async () => ({ ok: true }),
      ),
      platformRead(
        { pool },
        ctxFor(staffId, bad.requestId),
        { key: REGISTERED_KEY, reason: 'sibling B, injected failure' },
        async () => {
          throw new Error('injected platform-read failure (c2 sibling probe)');
        },
      ),
      platformRead(
        { pool },
        ctxFor(staffId, goodB.requestId),
        { key: REGISTERED_KEY, reason: 'sibling C, must commit' },
        async () => ({ ok: true }),
      ),
    ]);

    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]?.status).toBe('fulfilled');

    expect(await auditRowFor(goodA.requestId)).toBeDefined();
    expect(await auditRowFor(bad.requestId)).toBeUndefined();
    expect(await auditRowFor(goodB.requestId)).toBeDefined();
  });
});
