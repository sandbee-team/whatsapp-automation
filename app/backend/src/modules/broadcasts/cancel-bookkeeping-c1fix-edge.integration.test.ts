import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  runOneCancelBookkeepingSweep,
  type CancelBookkeepingSweepDeps,
} from './cancel-bookkeeping.js';
import {
  cleanupBroadcastProbeClients,
  seedBroadcastTenant,
  type TestPool,
} from './__tests__/broadcasts-test-support.js';
import {
  fetchMessageJobsPartitionMonthStarts,
  seedCancelledCampaign,
  seedNoiseInstance,
} from './__tests__/cancel-bookkeeping-c1fix-support.js';

/**
 * cancel-bookkeeping-c1fix-edge.integration.test.ts (P23 C1 fix round, unit
 * F1, max-lines sibling of `cancel-bookkeeping-c1fix.integration.test.ts`) -
 * the remaining two confirmed findings: (2) the per-campaign job stamp's
 * SELECT must probe an index, never Seq Scan `message_jobs` at realistic
 * partition volume; (3) a per-campaign failure must be logged ids-only and
 * never abort the rest of the sweep.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'broadcast-cancel-bookkeeping-c1fix-edge-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupBroadcastProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('cancel bookkeeping - C1 fix round (F1), edge proofs', () => {
  it('the_stamp_select_uses_an_index_scan_and_never_a_seq_scan_on_message_jobs', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const campaignId = await seedCancelledCampaign(pool, tenant, 0, 0, 3);

    // Noise rows for a DIFFERENT instance under the same client, so the
    // target instance's 3 rows are a small selective slice - realistic
    // partition volume, same shape as db/tests/helpers/claim-plan-fixture.ts's
    // own representative seed. EVERY existing message_jobs partition gets
    // real rows so none is left empty: an empty partition legitimately Seq
    // Scans (cheapest plan for zero rows, not a defect) and would otherwise
    // fail this exact assertion regardless of the fix under test.
    const noiseInstanceId = await seedNoiseInstance(pool, tenant.clientId);
    const partitionStarts = await fetchMessageJobsPartitionMonthStarts(pool);
    let seq = 0;
    for (const monthStart of partitionStarts) {
      for (let i = 0; i < 300; i += 1) {
        await pool.query(
          `INSERT INTO message_jobs
             (client_id, instance_id, campaign_id, recipient_jid, recipient_e164,
              payload, payload_kind, priority, priority_rank, status, send_origin,
              created_at, scheduled_at, next_attempt_at)
           VALUES ($1, $2, NULL, $3, $4, $5, 'text', 'low', 1, 'queued', 'direct', $6, $6, $6)`,
          [
            tenant.clientId,
            noiseInstanceId,
            `1900000${String(seq).padStart(5, '0')}@s.whatsapp.net`,
            `+1900000${String(seq).padStart(5, '0')}`,
            JSON.stringify({ kind: 'text', body: 'noise row' }),
            monthStart,
          ],
        );
        seq += 1;
      }
    }
    await pool.query('ANALYZE message_jobs');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.client_id', tenant.clientId]);
      const result = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (FORMAT TEXT) SELECT id, created_at FROM message_jobs
          WHERE client_id = $1 AND instance_id = $2 AND campaign_id = $3 AND status = 'queued'
          ORDER BY id
          LIMIT $4`,
        [tenant.clientId, tenant.instanceId, campaignId, 500],
      );
      const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).not.toContain('Seq Scan on message_jobs');
      expect(plan).toMatch(/Index (Only )?Scan/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('a_campaign_whose_tenantdb_throws_is_logged_ids_only_and_the_next_campaign_still_runs', async () => {
    const tenant = await seedBroadcastTenant(pool, probeClientIds);
    const badCampaignId = await seedCancelledCampaign(pool, tenant, 1, 0, 0);
    const goodCampaignId = await seedCancelledCampaign(pool, tenant, 1, 0, 0);
    // Make the "bad" campaign sort first (older updated_at).
    await pool.query(`UPDATE campaigns SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      badCampaignId,
    ]);

    const failingTenantDb: TenantDb = {
      async withTenant(clientId, fn) {
        return tenantDb.withTenant(clientId, async (tx) => {
          const wrapped = {
            query: (async (sql: string, params?: unknown[]) => {
              if (sql.includes('UPDATE campaign_recipients')) {
                const bound = (params ?? []) as unknown[];
                if (bound.includes(badCampaignId)) {
                  throw new Error('simulated tenantDb failure');
                }
              }
              return tx.query(sql, params);
            }) as never,
          };
          return fn(wrapped);
        });
      },
    };

    const warnSpy = vi.fn();
    const deps: CancelBookkeepingSweepDeps = {
      pool,
      tenantDb: failingTenantDb,
      logger: { warn: warnSpy },
    };
    await runOneCancelBookkeepingSweep(deps);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    // `campaign_id` is not in @wp/server-kit's LogFields allow-list, so the
    // id is carried in the free-text message instead - meta stays limited to
    // the allow-listed client_id, ids-only, never a structured PII field.
    expect(meta).toEqual({ client_id: tenant.clientId });
    expect(message).toContain(badCampaignId);
    expect(JSON.stringify(meta)).not.toMatch(/@s\.whatsapp\.net|phone|body/i);
    expect(message).not.toMatch(/@s\.whatsapp\.net/);

    const goodCounters = await pool.query<{ cancelled: number }>(
      `SELECT cancelled FROM campaign_counters WHERE campaign_id = $1 AND client_id = $2`,
      [goodCampaignId, tenant.clientId],
    );
    expect(goodCounters.rows[0]?.cancelled).toBe(1);
  });
});
