import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { bindInboundMetrics } from './metrics.js';
import { recordInboundReceipt, type InboundReceipt } from './receipts.js';
import { seedJobRef } from './__tests__/optout-inbound-test-support.js';

/**
 * receipt-stamp-tenant-c2b.integration.test.ts (P23a C2b hardening pass) -
 * the residual two-tenant angle over `stampCampaignRecipientReceipt`: tenant
 * A and tenant B each have a campaign recipient wired to a DIFFERENT
 * `message_job`, but the receipt for A's `wa_msg_id` is delivered under
 * B's `RecordReceiptDeps` (`clientId: B, instanceId: B`). `message_wa_ids`
 * is itself scoped `(client_id, instance_id, direction, wa_msg_id)`, so B's
 * lookup of A's wa_msg_id matches zero rows - `unmatched`, never a
 * cross-tenant stamp - and A's own recipient row is untouched (byte-identical
 * `row_to_json`).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'receipt-stamp-tenant-c2b-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM campaign_recipients WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM campaigns WHERE client_id = ANY($1)', [probeClientIds]);
  await pool.query('DELETE FROM contacts WHERE client_id = ANY($1)', [probeClientIds]);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

interface SeededSentJob {
  jobId: string;
  waMsgId: string;
  publicId: string;
}

async function seedSentCampaignJob(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
): Promise<SeededSentJob> {
  const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const jobResult = await testPool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, '+15550001234', $4, $5, 'text', 'normal', 3, 'sent', now(), now(),
             1, 5, now())
     RETURNING id, created_at`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      Buffer.from('probe-hash'),
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('seedSentCampaignJob: no message_jobs row returned');
  const publicId = await seedJobRef(testPool, clientId, instanceId, jobRow.id);

  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4
       -- client_id = $1`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );

  return { jobId: jobRow.id, waMsgId, publicId };
}

async function seedCampaignAndContact(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
): Promise<string> {
  const campaignId = randomUUID();
  const contactId = randomUUID();
  await testPool.query(
    `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, '+15559990000', $3, '15559990000@s.whatsapp.net', 'manual')
     -- client_id = $2`,
    [contactId, clientId, Buffer.from(`tenant-probe-${clientId}`)],
  );
  await testPool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
     VALUES ($1, $2, $3, 'running', 'two-tenant receipt probe', $4, $5)
     -- client_id = $2`,
    [
      campaignId,
      clientId,
      instanceId,
      JSON.stringify({ kind: 'contacts', tagIds: [], contactIds: [contactId] }),
      JSON.stringify({ kind: 'text', body: 'hi' }),
    ],
  );
  return campaignId;
}

async function seedCampaignRecipient(
  testPool: TestPool,
  clientId: string,
  campaignId: string,
  messageJobPublicId: string,
): Promise<void> {
  const contactResult = await testPool.query<{ id: string }>(
    `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, '+15559990001', $3, '15559990001@s.whatsapp.net', 'manual')
     RETURNING id
     -- client_id = $2`,
    [randomUUID(), clientId, Buffer.from(`recipient-probe-hash-${messageJobPublicId}`)],
  );
  const contactId = contactResult.rows[0]?.id;
  if (!contactId) throw new Error('seedCampaignRecipient: no contacts row returned');

  await testPool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, contact_id, recipient_jid, recipient_hash, status, message_job_public_id)
     VALUES ($1, $2, $3, '15559990001@s.whatsapp.net', $4, 'sent', $5)
     -- client_id = $1`,
    [
      clientId,
      campaignId,
      contactId,
      Buffer.from(`recipient-probe-hash-${messageJobPublicId}`),
      messageJobPublicId,
    ],
  );
}

async function recipientRowJson(
  testPool: TestPool,
  clientId: string,
  messageJobPublicId: string,
): Promise<string | undefined> {
  const result = await testPool.query<{ row_json: string }>(
    `SELECT row_to_json(r)::text AS row_json FROM campaign_recipients r
       WHERE r.client_id = $1 AND r.message_job_public_id = $2
       -- client_id = $1`,
    [clientId, messageJobPublicId],
  );
  return result.rows[0]?.row_json;
}

function deliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1000',
    participantJid: '',
  };
}

describe('two-tenant receipt cross-delivery hardening (P23a C2b)', () => {
  it('a_receipt_for_tenant_as_wa_msg_id_delivered_under_tenant_bs_deps_is_unmatched_and_a_is_untouched', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);

    const campaignA = await seedCampaignAndContact(pool, tenantA.clientId, tenantA.instanceId);
    const { waMsgId: waMsgIdA, publicId: publicIdA } = await seedSentCampaignJob(
      pool,
      tenantA.clientId,
      tenantA.instanceId,
    );
    await seedCampaignRecipient(pool, tenantA.clientId, campaignA, publicIdA);

    const campaignB = await seedCampaignAndContact(pool, tenantB.clientId, tenantB.instanceId);
    const { waMsgId: waMsgIdB, publicId: publicIdB } = await seedSentCampaignJob(
      pool,
      tenantB.clientId,
      tenantB.instanceId,
    );
    await seedCampaignRecipient(pool, tenantB.clientId, campaignB, publicIdB);
    expect(waMsgIdA).not.toBe(waMsgIdB);

    const beforeA = await recipientRowJson(pool, tenantA.clientId, publicIdA);

    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    // A's wa_msg_id delivered under B's deps (clientId/instanceId both B).
    const outcome = await recordInboundReceipt(
      { tenantDb, clientId: tenantB.clientId, instanceId: tenantB.instanceId, metrics },
      deliveredReceipt(waMsgIdA),
    );
    expect(outcome).toBe('unmatched');

    // A's recipient row is byte-identical - no cross-tenant stamp occurred.
    const afterA = await recipientRowJson(pool, tenantA.clientId, publicIdA);
    expect(afterA).toEqual(beforeA);

    // B's own recipient row (unrelated to this receipt) is also untouched.
    const bRow = await pool.query<{ status: string }>(
      `SELECT status FROM campaign_recipients WHERE client_id = $1 AND message_job_public_id = $2`,
      [tenantB.clientId, publicIdB],
    );
    expect(bRow.rows[0]?.status).toBe('sent');

    // No message_wa_ids row exists for A's wa_msg_id under B's tenant scope
    // (proving *why* it is unmatched - the join key itself never resolves
    // cross-tenant).
    const crossRow = await pool.query(
      `SELECT 1 FROM message_wa_ids
        WHERE client_id = $1 AND instance_id = $2 AND direction = 'out' AND wa_msg_id = $3`,
      [tenantB.clientId, tenantB.instanceId, waMsgIdA],
    );
    expect(crossRow.rowCount).toBe(0);
  });
});
