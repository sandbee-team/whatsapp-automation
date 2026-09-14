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
 * receipts-campaign-stamp.integration.test.ts (P23a Unit U1b, step 3) - real
 * Postgres proof that a receipt for a campaign send advances the matching
 * `campaign_recipients` row (`sent -> delivered -> read`, monotonic,
 * idempotent on replay), and that a receipt for a non-campaign job touches
 * zero `campaign_recipients` rows.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'receipts-campaign-stamp-test',
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
  jobCreatedAt: Date;
  waMsgId: string;
  publicId: string;
}

/** Seeds a 'sent' message_jobs row (real Postgres now(), never a JS Date) plus its message_job_refs row and an 'out' message_wa_ids row for waMsgId. */
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

  return { jobId: jobRow.id, jobCreatedAt: jobRow.created_at, waMsgId, publicId };
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
    [contactId, clientId, Buffer.from('contact-probe-hash')],
  );
  await testPool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
     VALUES ($1, $2, $3, 'running', 'receipt stamp probe', $4, $5)
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
  status = 'sent',
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
     VALUES ($1, $2, $3, '15559990001@s.whatsapp.net', $4, $5, $6)
     -- client_id = $1`,
    [
      clientId,
      campaignId,
      contactId,
      Buffer.from(`recipient-probe-hash-${messageJobPublicId}`),
      status,
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

function readReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'read',
    eventTs: '2000',
    participantJid: '',
  };
}

describe('receipt -> campaign_recipients stamping (real Postgres)', () => {
  it('a_receipt_for_a_campaign_job_stamps_its_recipient_once', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const campaignId = await seedCampaignAndContact(pool, clientId, instanceId);
    const { waMsgId, publicId } = await seedSentCampaignJob(pool, clientId, instanceId);
    await seedCampaignRecipient(pool, clientId, campaignId, publicId, 'sent');

    const deliveredOutcome = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    expect(deliveredOutcome).toBe('recorded');

    const afterDelivered = await pool.query<{
      status: string;
      delivered_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT status, delivered_at, read_at FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [clientId, publicId],
    );
    expect(afterDelivered.rows[0]?.status).toBe('delivered');
    expect(afterDelivered.rows[0]?.delivered_at).not.toBeNull();
    expect(afterDelivered.rows[0]?.read_at).toBeNull();
    const deliveredAtValue = afterDelivered.rows[0]?.delivered_at;

    const readOutcome = await recordInboundReceipt(deps, readReceipt(waMsgId));
    expect(readOutcome).toBe('recorded');

    const afterRead = await pool.query<{
      status: string;
      delivered_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT status, delivered_at, read_at FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [clientId, publicId],
    );
    expect(afterRead.rows[0]?.status).toBe('read');
    expect(afterRead.rows[0]?.read_at).not.toBeNull();
    expect(afterRead.rows[0]?.delivered_at).toEqual(deliveredAtValue);

    const beforeReplay = await recipientRowJson(pool, clientId, publicId);

    const replayedDelivered = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    expect(replayedDelivered).toBe('duplicate');
    const replayedRead = await recordInboundReceipt(deps, readReceipt(waMsgId));
    expect(replayedRead).toBe('duplicate');

    const afterReplay = await recipientRowJson(pool, clientId, publicId);
    expect(afterReplay).toEqual(beforeReplay);

    // A second, non-campaign job's receipt: no recipient row for it.
    const { waMsgId: otherWaMsgId } = await seedSentCampaignJob(pool, clientId, instanceId);
    const otherOutcome = await recordInboundReceipt(deps, deliveredReceipt(otherWaMsgId));
    expect(otherOutcome).toBe('recorded');

    const otherRecipients = await pool.query(
      `SELECT id FROM campaign_recipients WHERE client_id = $1 AND message_job_public_id IS NULL
         -- client_id = $1`,
      [clientId],
    );
    expect(otherRecipients.rowCount).toBe(0);
  });

  it('a_read_receipt_before_delivered_still_advances_monotonically', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const campaignId = await seedCampaignAndContact(pool, clientId, instanceId);
    const { waMsgId, publicId } = await seedSentCampaignJob(pool, clientId, instanceId);
    await seedCampaignRecipient(pool, clientId, campaignId, publicId, 'sent');

    const readOutcome = await recordInboundReceipt(deps, readReceipt(waMsgId));
    expect(readOutcome).toBe('recorded');

    const afterRead = await pool.query<{
      status: string;
      delivered_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT status, delivered_at, read_at FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [clientId, publicId],
    );
    expect(afterRead.rows[0]?.status).toBe('read');
    expect(afterRead.rows[0]?.read_at).not.toBeNull();
    expect(afterRead.rows[0]?.delivered_at).toBeNull();

    const deliveredOutcome = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    expect(deliveredOutcome).toBe('recorded');

    const afterDelivered = await pool.query<{
      status: string;
      delivered_at: Date | null;
      read_at: Date | null;
    }>(
      `SELECT status, delivered_at, read_at FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [clientId, publicId],
    );
    expect(afterDelivered.rows[0]?.delivered_at).not.toBeNull();
    expect(afterDelivered.rows[0]?.status).toBe('read');
  });
});
