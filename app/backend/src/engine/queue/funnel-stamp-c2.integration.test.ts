import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindInboundMetrics } from '../../modules/inbound/metrics.js';
import { recordInboundReceipt, type InboundReceipt } from '../../modules/inbound/receipts.js';
import { seedJobRef } from '../../modules/inbound/__tests__/optout-inbound-test-support.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';
import { recipientRow, seedCampaignForJob } from './__tests__/funnel-stamp-edge-support.js';

/**
 * funnel-stamp-c2.integration.test.ts (P23a test-engineer hardening pass,
 * max-lines split of funnel-stamp-edge.integration.test.ts) -
 * `stampCampaignRecipientReceipt` (receipt path, via `recordInboundReceipt`)
 * edge cases: a same-`wa_msg_id` collision across two tenants never crosses
 * (the match itself is scoped by client_id+instance_id), and a `failed`
 * receipt type stamps nothing on the recipient.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'funnel-stamp-c2-test',
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

async function seedSentJobWithWaId(
  clientId: string,
  instanceId: string,
  waMsgId: string,
): Promise<{ jobId: string; jobCreatedAt: Date; publicId: string }> {
  const jobResult = await pool.query<{ id: string; created_at: Date }>(
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
      Buffer.from(`funnel-stamp-edge-hash-${clientId}`),
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('no message_jobs row returned');
  const publicId = await seedJobRef(pool, clientId, instanceId, jobRow.id);
  await pool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4
       -- client_id = $1`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );
  return { jobId: jobRow.id, jobCreatedAt: jobRow.created_at, publicId };
}

describe('funnel receipt stamping edge cases (P23a hardening)', () => {
  it('a_receipt_whose_message_wa_id_belongs_to_another_tenant_with_the_same_wa_msg_id_never_stamps_this_tenant', async () => {
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;

    const { clientId: clientA, instanceId: instanceA } = await seedSendTenant(pool, probeClientIds);
    const { clientId: clientB, instanceId: instanceB } = await seedSendTenant(pool, probeClientIds);

    const jobA = await seedSentJobWithWaId(clientA, instanceA, waMsgId);
    const jobB = await seedSentJobWithWaId(clientB, instanceB, waMsgId);

    await seedCampaignForJob(pool, clientA, instanceA, jobA.jobId, jobA.publicId, 'sent');
    await seedCampaignForJob(pool, clientB, instanceB, jobB.jobId, jobB.publicId, 'sent');

    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const deliveredReceipt: InboundReceipt = {
      waMsgId,
      remoteJid: 'a@s.whatsapp.net',
      eventType: 'delivered',
      eventTs: '1000',
      participantJid: '',
    };

    // Tenant A's receipt (matched against tenant A's own message_wa_ids row,
    // scoped by client_id+instance_id) only ever stamps tenant A's recipient.
    const outcomeA = await recordInboundReceipt(
      { tenantDb, clientId: clientA, instanceId: instanceA, metrics },
      deliveredReceipt,
    );
    expect(outcomeA).toBe('recorded');

    const rowA = await recipientRow(pool, clientA, jobA.publicId);
    const rowB = await recipientRow(pool, clientB, jobB.publicId);
    expect(rowA?.status).toBe('delivered');
    expect(rowB?.status).toBe('sent'); // untouched by tenant A's receipt
  });

  it('a_failed_receipt_type_stamps_nothing_on_the_recipient', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const job = await seedSentJobWithWaId(clientId, instanceId, waMsgId);
    await seedCampaignForJob(pool, clientId, instanceId, job.jobId, job.publicId, 'sent');

    const outcome = await recordInboundReceipt(
      { tenantDb, clientId, instanceId, metrics },
      {
        waMsgId,
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'failed',
        eventTs: '1000',
        participantJid: '',
      },
    );
    expect(outcome).toBe('recorded');

    const row = await recipientRow(pool, clientId, job.publicId);
    expect(row?.status).toBe('sent');
  });
});
