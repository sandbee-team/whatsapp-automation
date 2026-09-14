import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  recomputeCampaignFunnel,
  runCancelBookkeepingBatch,
} from '../../modules/broadcasts/index.js';
import { ClaimLostDuringSend, resolveAck, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';
import { recipientRow, seedCampaignForJob } from './__tests__/funnel-stamp-edge-support.js';

/**
 * funnel-stamp-edge.integration.test.ts (P23a test-engineer hardening pass;
 * P23a fix round unit F2) - `stampCampaignRecipientSent` (send-result, via
 * `resolveAck`) edge cases: a send that completes across an in-flight cancel
 * (claimed before the cancel commit, so cancel-bookkeeping already stamped
 * the recipient 'cancelled') stamps the recipient 'sent' and charged - the
 * job row, the money side, and the funnel row now always agree - and a
 * missing `message_job_refs` row never throws and still charges once. Also
 * covers the inverse ordering: cancel bookkeeping running AFTER the send
 * stamp must never revert an already-'sent' recipient back to 'cancelled'.
 * Receipt-path edge cases live in the max-lines sibling
 * `funnel-stamp-c2.integration.test.ts`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'funnel-stamp-edge-test',
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

describe('funnel send-result stamping edge cases (P23a hardening)', () => {
  it('a_send_completed_across_an_in_flight_cancel_stamps_the_recipient_sent_and_charged', async () => {
    // In-flight-across-cancel: the recipient row was already stamped
    // 'cancelled' by cancel-bookkeeping (which only ever touches
    // pending/queued rows in the real path - this manually seeds the
    // "cancel bookkeeping ran while the send was in flight" outcome
    // directly) BEFORE resolveAck's send-result stamp runs. The job was
    // claimed before the cancel committed, so the send legitimately
    // completes and charges - the funnel row must mirror that truth.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
      'cancelled',
    );
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    const ackInput = {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
      jobId: seeded.jobId,
      jobCreatedAt: seeded.jobCreatedAt,
      leaseId: seeded.leaseId,
      attemptNo: seeded.attemptNo,
      publicId: seeded.publicId,
      outcome: { providerMsgId: 'wamid.funnel-stamp-edge-cancelled' },
      payloadKind: 'text' as const,
      recipientJid: '15550000000@s.whatsapp.net',
      campaignId,
    };

    await resolveAck(ackInput, deps);

    const ledgerRows = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRows.rows).toEqual([{ amount_minor: '-15' }]);

    const row = await recipientRow(pool, seeded.clientId, seeded.publicId);
    // The send genuinely completed and charged - the recipient must mirror
    // the job's truth ('sent'), even though cancel-bookkeeping stamped it
    // 'cancelled' first. Funnel truth = money truth = job truth.
    expect(row?.status).toBe('sent');
    expect(row?.sent_at).not.toBeNull();
    expect(row?.charged_minor).toBe('15');

    const beforeReplay = await pool.query<{ row: unknown }>(
      `SELECT row_to_json(r) AS row FROM campaign_recipients r
         WHERE client_id = $1 AND message_job_public_id = $2`,
      [seeded.clientId, seeded.publicId],
    );

    // A second resolveAck replay (retry-safe ack delivery) must leave the
    // recipient row byte-identical - the lease-guarded job/attempt write no
    // longer matches (job already 'sent'), which resolveAck reports as
    // ClaimLostDuringSend (same pattern as `result-campaign-stamp.
    // integration.test.ts#replaying_the_ack_leaves_the_recipient_byte_identical`).
    try {
      await resolveAck(ackInput, deps);
    } catch (err) {
      if (!(err instanceof ClaimLostDuringSend)) {
        throw err;
      }
    }

    const afterReplay = await pool.query<{ row: unknown }>(
      `SELECT row_to_json(r) AS row FROM campaign_recipients r
         WHERE client_id = $1 AND message_job_public_id = $2`,
      [seeded.clientId, seeded.publicId],
    );
    expect(afterReplay.rows[0]?.row).toEqual(beforeReplay.rows[0]?.row);
  });

  it('cancel_bookkeeping_running_after_the_send_stamp_does_not_revert_a_sent_recipient', async () => {
    // Inverse ordering: the send stamp ('sent') commits FIRST, and cancel
    // bookkeeping for the same (now-cancelled) campaign runs AFTER. Cancel
    // bookkeeping's own WHERE guard (`status IN ('pending','queued')`) must
    // never touch the already-'sent' row.
    const seededSent = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seededSent.clientId,
      seededSent.instanceId,
      seededSent.jobId,
      seededSent.publicId,
      'queued',
    );
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await resolveAck(
      {
        clientId: seededSent.clientId,
        instanceId: seededSent.instanceId,
        jobId: seededSent.jobId,
        jobCreatedAt: seededSent.jobCreatedAt,
        leaseId: seededSent.leaseId,
        attemptNo: seededSent.attemptNo,
        publicId: seededSent.publicId,
        outcome: { providerMsgId: 'wamid.funnel-stamp-cancel-race' },
        payloadKind: 'text',
        recipientJid: '15550000001@s.whatsapp.net',
        campaignId,
      },
      deps,
    );

    const sentRow = await recipientRow(pool, seededSent.clientId, seededSent.publicId);
    expect(sentRow?.status).toBe('sent');

    // A second recipient on the same campaign stays 'queued' (never sent),
    // so the cancel sweep has genuine pending/queued work to stamp.
    const seededQueued = await seedDispatchedAttempt(pool, probeClientIds);
    await pool.query('UPDATE message_jobs SET campaign_id = $1 WHERE id = $2 AND client_id = $3', [
      campaignId,
      seededQueued.jobId,
      seededQueued.clientId,
    ]);
    const secondContactId = randomUUID();
    await pool.query(
      `INSERT INTO contacts (id, client_id, phone_e164, phone_hash, wa_jid, source)
       VALUES ($1, $2, '+15550000002', $3, '15550000002@s.whatsapp.net', 'manual')
       -- client_id = $2`,
      [secondContactId, seededSent.clientId, Buffer.from('funnel-stamp-cancel-race-second')],
    );
    await pool.query(
      `INSERT INTO campaign_recipients
         (client_id, campaign_id, contact_id, recipient_jid, recipient_hash, status, message_job_public_id)
       VALUES ($1, $2, $3, '15550000002@s.whatsapp.net', $4, 'queued', $5)
       -- client_id = $1`,
      [
        seededSent.clientId,
        campaignId,
        secondContactId,
        Buffer.from('funnel-stamp-cancel-race-second'),
        seededQueued.publicId,
      ],
    );
    await pool.query(`UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND client_id = $2`, [
      campaignId,
      seededSent.clientId,
    ]);

    const sweepResult = await runCancelBookkeepingBatch(tenantDb, {
      clientId: seededSent.clientId,
      campaignId,
    });
    expect(sweepResult.recipientsStamped).toBe(1);

    const sentRowAfterSweep = await recipientRow(pool, seededSent.clientId, seededSent.publicId);
    expect(sentRowAfterSweep?.status).toBe('sent');

    const recompute = await recomputeCampaignFunnel(tenantDb, {
      clientId: seededSent.clientId,
      campaignId,
    });
    expect(recompute.changed).toBe(true);

    const counters = await pool.query<{ sent: number; cancelled: number; total: number }>(
      `SELECT sent, cancelled, total FROM campaign_counters
        WHERE campaign_id = $1 AND client_id = $2`,
      [campaignId, seededSent.clientId],
    );
    expect(counters.rows[0]).toEqual({ sent: 1, cancelled: 1, total: 2 });
  });

  it('resolveack_for_a_campaign_job_with_no_message_job_refs_row_stamps_nothing_and_does_not_throw_and_still_charges_once', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const campaignId = await seedCampaignForJob(
      pool,
      seeded.clientId,
      seeded.instanceId,
      seeded.jobId,
      seeded.publicId,
      'queued',
    );
    // Delete the ref row AFTER seeding the recipient (which needed the
    // publicId) - simulates "expansion is ref-first, but this ref got
    // deleted" (should be impossible in the real path; asserted here as the
    // fail-safe boundary).
    await pool.query('DELETE FROM message_job_refs WHERE client_id = $1 AND message_job_id = $2', [
      seeded.clientId,
      seeded.jobId,
    ]);

    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

    await expect(
      resolveAck(
        {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          jobId: seeded.jobId,
          jobCreatedAt: seeded.jobCreatedAt,
          leaseId: seeded.leaseId,
          attemptNo: seeded.attemptNo,
          publicId: seeded.publicId,
          outcome: { providerMsgId: 'wamid.funnel-stamp-edge-no-ref' },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
          campaignId,
        },
        deps,
      ),
    ).resolves.toBeUndefined();

    const row = await recipientRow(pool, seeded.clientId, seeded.publicId);
    expect(row?.status).toBe('queued'); // untouched - the ref-join matched nothing

    const ledgerRows = await pool.query<{ amount_minor: string }>(
      'SELECT amount_minor::text FROM wallet_ledger WHERE client_id = $1',
      [seeded.clientId],
    );
    expect(ledgerRows.rows).toEqual([{ amount_minor: '-15' }]);
  });
});
