import { randomUUID } from 'node:crypto';
import {
  seedBroadcastCampaign,
  type SeededBroadcastTenant,
  type TestPool,
} from './broadcasts-test-support.js';

/**
 * funnel-test-support.ts (P23a Unit U2) - shared, non-test fixture helpers
 * for `funnel.integration.test.ts` and its max-lines-split sibling
 * `funnel-sweep-tenant-isolation.integration.test.ts`. Lives under
 * `__tests__/` so the tenant-scope guard's seed/cleanup exemption covers its
 * raw INSERTs (same convention as `broadcasts-test-support.ts` itself), and
 * vitest's `include` glob never picks it up as its own suite (no `.test.ts`
 * suffix).
 */

export interface CountersRow extends Record<string, unknown> {
  total: number;
  pending: number;
  skipped: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  cancelled: number;
  charged_minor: string;
}

/** Reads `campaign_counters` for `campaignId`, all nine buckets plus `charged_minor` - exact-value assertions only, never a bound. */
export async function readCounters(pool: TestPool, campaignId: string): Promise<CountersRow> {
  const result = await pool.query<CountersRow>(
    `SELECT total, pending, skipped, queued, sent, delivered, read, failed, cancelled, charged_minor
       FROM campaign_counters WHERE campaign_id = $1`,
    [campaignId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('funnel test: campaign_counters row missing');
  return row;
}

/** Seeds a campaign in `status` + its zero counters row + a group-targeted recipient set matching the given per-status counts (contact_id NULL, group_id set, so `cr_exactly_one_target` is satisfied without seeding real contacts). */
export async function seedCampaignWithRecipients(
  pool: TestPool,
  tenant: SeededBroadcastTenant,
  status: string,
  counts: Record<string, number>,
  expandDoneAt: boolean,
): Promise<string> {
  const campaignId = await seedBroadcastCampaign(pool, tenant, { status, body: 'hello' });
  if (expandDoneAt) {
    await pool.query(`UPDATE campaigns SET expand_done_at = now() WHERE id = $1`, [campaignId]);
  }
  await pool.query(`INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)`, [
    campaignId,
    tenant.clientId,
  ]);

  const groupTargeted = async (recipStatus: string, n: number, chargedMinor: number | null) => {
    for (let i = 0; i < n; i += 1) {
      const groupId = randomUUID();
      await pool.query(
        `INSERT INTO campaign_recipients
           (client_id, campaign_id, group_id, recipient_jid, recipient_hash, status, charged_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenant.clientId,
          campaignId,
          groupId,
          `${randomUUID()}@g.us`,
          Buffer.from(randomUUID()),
          recipStatus,
          chargedMinor,
        ],
      );
    }
  };

  for (const [status_, n] of Object.entries(counts)) {
    if (status_ === 'sent') {
      await groupTargeted('sent', n, 15);
    } else {
      await groupTargeted(status_, n, null);
    }
  }

  return campaignId;
}
