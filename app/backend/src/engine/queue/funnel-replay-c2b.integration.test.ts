import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  recomputeCampaignFunnel,
  runCancelBookkeepingBatch,
} from '../../modules/broadcasts/index.js';
import { resolveAck, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';
import { seedCampaignForJob } from './__tests__/funnel-stamp-edge-support.js';

/**
 * funnel-replay-c2b.integration.test.ts (P23a C2b hardening pass) - a
 * multi-step replay through the funnel: cancel bookkeeping stamps a whole
 * campaign's non-terminal recipients `cancelled`, TWO recomputes run
 * (proving the second is idempotent - `changed: false`), then one of those
 * "cancelled" recipients' underlying job is completed via `resolveAck` (the
 * "claimed before cancel committed" race `funnel-stamp-edge.integration.
 * test.ts` already proves at the single-recipient level) and a final
 * recompute reconciles `campaign_counters` to the exact truth: `sent: 1`,
 * `cancelled: n-1`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'funnel-replay-c2b-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaign_counters WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/** Inserts one extra 'queued' campaign_recipients row (no message_jobs row of its own - cancel-bookkeeping's recipient-side stamp needs none) for the SAME campaign. */
async function addQueuedRecipient(
  testPool: TestPool,
  clientId: string,
  campaignId: string,
  seq: number,
): Promise<void> {
  const contactId = randomUUID();
  const hash = Buffer.from(`funnel-replay-extra-${campaignId}-${String(seq)}`);
  await testPool.query(
    `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, $3, $4, $5, 'manual')
     -- client_id = $2`,
    [
      contactId,
      clientId,
      `+1555000${String(9000 + seq)}`,
      hash,
      `1555000${String(9000 + seq)}@s.whatsapp.net`,
    ],
  );
  await testPool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, contact_id, recipient_jid, recipient_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     -- client_id = $1`,
    [clientId, campaignId, contactId, `1555000${String(9000 + seq)}@s.whatsapp.net`, hash],
  );
}

describe('progress funnel multi-step replay hardening (P23a C2b)', () => {
  it('cancel_then_two_recomputes_then_one_recipients_send_completes_then_a_final_recompute_matches_the_exact_recount', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
      'queued',
    );
    await pool.query(`INSERT INTO campaign_counters (campaign_id, client_id) VALUES ($1, $2)`, [
      campaignId,
      seeded.clientId,
    ]);
    // Two more recipients on the same campaign, no jobs of their own.
    await addQueuedRecipient(pool, seeded.clientId, campaignId, 1);
    await addQueuedRecipient(pool, seeded.clientId, campaignId, 2);

    const tenantDb = createTenantDb(pool);

    // Cancel the campaign, then run bookkeeping - all 3 recipients
    // ('queued') get stamped 'cancelled' in this pass (cancel-bookkeeping
    // runs regardless of the underlying job's real state - the job-side
    // predicate is the actual enforcement point, not this recipient stamp).
    await pool.query(`UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND client_id = $2`, [
      campaignId,
      seeded.clientId,
    ]);
    const sweepResult = await runCancelBookkeepingBatch(tenantDb, {
      clientId: seeded.clientId,
      campaignId,
    });
    expect(sweepResult.recipientsStamped).toBe(3);

    // First recompute reconciles counters to the post-cancel truth.
    const first = await recomputeCampaignFunnel(tenantDb, {
      clientId: seeded.clientId,
      campaignId,
    });
    expect(first.changed).toBe(true);
    const countersAfterFirst = await pool.query<{
      sent: number;
      cancelled: number;
      total: number;
    }>(`SELECT sent, cancelled, total FROM campaign_counters WHERE campaign_id = $1`, [campaignId]);
    expect(countersAfterFirst.rows[0]).toEqual({ sent: 0, cancelled: 3, total: 3 });

    // Second recompute is a true no-op - nothing changed since the first.
    const second = await recomputeCampaignFunnel(tenantDb, {
      clientId: seeded.clientId,
      campaignId,
    });
    expect(second.changed).toBe(false);

    // The original job's send completes (claimed before the cancel
    // committed) - resolveAck stamps its recipient 'sent', overriding the
    // 'cancelled' cancel-bookkeeping had already written.
    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.funnel-replay-c2b' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
        campaignId,
      },
      deps,
    );

    const sentRow = await pool.query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE client_id = $1 AND message_job_public_id = $2`,
      [seeded.clientId, seeded.publicId],
    );
    expect(sentRow.rows[0]?.status).toBe('sent');

    // Final recompute: counters equal the exact recount - sent 1, cancelled
    // n-1 (2), total unchanged at 3.
    const final = await recomputeCampaignFunnel(tenantDb, {
      clientId: seeded.clientId,
      campaignId,
    });
    expect(final.changed).toBe(true);
    const finalCounters = await pool.query<{ sent: number; cancelled: number; total: number }>(
      `SELECT sent, cancelled, total FROM campaign_counters WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(finalCounters.rows[0]).toEqual({ sent: 1, cancelled: 2, total: 3 });
  });
});
