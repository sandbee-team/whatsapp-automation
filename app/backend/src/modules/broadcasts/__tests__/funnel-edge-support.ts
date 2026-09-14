import type { TestPool } from './broadcasts-test-support.js';

/**
 * funnel-edge-support.ts (P23a test-engineer hardening pass) - shared helper
 * for `funnel-edge.integration.test.ts` and its max-lines sibling
 * `funnel-c2.integration.test.ts`. Lives under `__tests__/` for the same
 * tenant-scope guard exemption as its sibling support files (no `.test.ts`
 * suffix, never picked up as its own suite).
 */

/** Counts `campaign.progress` outbox rows for one campaign - exact-value assertions only. */
export async function countOutbox(pool: TestPool, campaignId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM outbox_events
      WHERE event_type = 'campaign.progress' AND entity_id = $1`,
    [campaignId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
