import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { ClaimLostDuringSend, resolveAck, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-campaign-stamp.integration.test.ts (P23a Unit U1b, step 3) - real
 * Postgres proof that a confirmed campaign send (`resolveAck`) stamps its
 * `campaign_recipients` row `queued -> sent` with the charged rate, that a
 * replay leaves the row byte-identical, and that a non-campaign send
 * stamps nothing.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-campaign-stamp-test',
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

async function seedCampaignForJob(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
  jobId: string,
  publicId: string,
): Promise<string> {
  const campaignId = randomUUID();
  const contactId = randomUUID();

  await testPool.query(
    `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
     VALUES ($1, $2, '+15559990002', $3, '15559990002@s.whatsapp.net', 'manual')
     -- client_id = $2`,
    [contactId, clientId, Buffer.from(`result-stamp-contact-${jobId}`)],
  );
  await testPool.query(
    `INSERT INTO campaigns (id, client_id, instance_id, status, name, audience, message)
     VALUES ($1, $2, $3, 'running', 'result stamp probe', $4, $5)
     -- client_id = $2`,
    [
      campaignId,
      clientId,
      instanceId,
      JSON.stringify({ kind: 'contacts', tagIds: [], contactIds: [contactId] }),
      JSON.stringify({ kind: 'text', body: 'hi' }),
    ],
  );
  await testPool.query(
    'UPDATE message_jobs SET campaign_id = $1 WHERE id = $2 AND client_id = $3',
    [campaignId, jobId, clientId],
  );
  await testPool.query(
    `INSERT INTO campaign_recipients
       (client_id, campaign_id, contact_id, recipient_jid, recipient_hash, status, message_job_public_id)
     VALUES ($1, $2, $3, '15559990002@s.whatsapp.net', $4, 'queued', $5)
     -- client_id = $1`,
    [clientId, campaignId, contactId, Buffer.from(`result-stamp-contact-${jobId}`), publicId],
  );

  return campaignId;
}

async function recipientRowJson(
  testPool: TestPool,
  clientId: string,
  publicId: string,
): Promise<string | undefined> {
  const result = await testPool.query<{ row_json: string }>(
    `SELECT row_to_json(r)::text AS row_json FROM campaign_recipients r
       WHERE r.client_id = $1 AND r.message_job_public_id = $2
       -- client_id = $1`,
    [clientId, publicId],
  );
  return result.rows[0]?.row_json;
}

describe('resolveAck campaign_recipients stamp - real Postgres', () => {
  it('a_confirmed_campaign_send_stamps_the_recipient_sent_with_the_charged_rate', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
    );
    const tenantDb = createTenantDb(pool);
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
        outcome: { providerMsgId: 'wamid.campaign' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
        campaignId,
      },
      deps,
    );

    const recipient = await pool.query<{
      status: string;
      sent_at: Date | null;
      charged_minor: string | null;
    }>(
      `SELECT status, sent_at, charged_minor::text FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [seeded.clientId, seeded.publicId],
    );
    expect(recipient.rows[0]?.status).toBe('sent');
    expect(recipient.rows[0]?.sent_at).not.toBeNull();
    expect(recipient.rows[0]?.charged_minor).toBe('15');

    const ledgerRows = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRows.rows).toEqual([{ amount_minor: '-15' }]);
  });

  it('replaying_the_ack_leaves_the_recipient_byte_identical', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
    );
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    const input = {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      outcome: { providerMsgId: 'wamid.campaign-replay' },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
      campaignId,
    };

    await resolveAck(input, deps);
    const before = await recipientRowJson(pool, seeded.clientId, seeded.publicId);

    try {
      await resolveAck(input, deps);
    } catch (err) {
      if (!(err instanceof ClaimLostDuringSend)) {
        throw err;
      }
    }

    const after = await recipientRowJson(pool, seeded.clientId, seeded.publicId);
    expect(after).toEqual(before);
  });

  it('a_claimed_job_whose_dispatch_publicid_is_numeric_still_gets_the_recipient_stamped', async () => {
    // Regression (P23a fix round): the REAL send loop's `dispatchInput.
    // publicId` is `job.id` (the numeric message_jobs id, see
    // send-loop.ts#jobToDispatchInput) - never the message_job_refs uuid.
    // The stamp must key off `jobId`, not `publicId`, or every real
    // campaign send 500 error's with "invalid input syntax for type uuid".
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
    );
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.jobId, // numeric job id, NOT the ref's uuid - the real-path shape
        outcome: { providerMsgId: 'wamid.campaign-numeric-publicid' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
        campaignId,
      },
      deps,
    );

    const recipient = await pool.query<{
      status: string;
      sent_at: Date | null;
      charged_minor: string | null;
    }>(
      `SELECT status, sent_at, charged_minor::text FROM campaign_recipients
         WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [seeded.clientId, seeded.publicId],
    );
    expect(recipient.rows[0]?.status).toBe('sent');
    expect(recipient.rows[0]?.sent_at).not.toBeNull();
    expect(recipient.rows[0]?.charged_minor).toBe('15');
  });

  it('a_non_campaign_send_stamps_nothing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
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
        outcome: { providerMsgId: 'wamid.non-campaign' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
        campaignId: null,
      },
      deps,
    );

    const recipients = await pool.query(
      `SELECT id FROM campaign_recipients WHERE client_id = $1 AND message_job_public_id = $2
         -- client_id = $1`,
      [seeded.clientId, seeded.publicId],
    );
    expect(recipients.rowCount).toBe(0);
  });
});
