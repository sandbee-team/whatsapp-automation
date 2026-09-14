import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { ClaimLostDuringSend, resolveAck, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedClaimedJob,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result.integration.test.ts (P11 Unit U4, step 7) - real Postgres,
 * `resolveAck` half only. `resolveFailure` + the mandatory slow-media soak
 * test live in the sibling `result-failure.integration.test.ts` (split at
 * the max-lines cap - topic split only, no behavior change). The
 * duplicate-inside-an-open-transaction proof (C1 CRITICAL fix) lives in
 * `result-delivery-event-transaction-survival.integration.test.ts` (same
 * max-lines-cap split idiom); the P18 wallet-debit proof lives in
 * `result-wallet-debit.integration.test.ts` (same idiom again). Every test
 * seeds its own attempt row already `state='dispatched'`
 * (`seedDispatchedAttempt`) rather than re-running `dispatch.ts`
 * (`dispatch.integration.test.ts` already proves the prepare/dispatch half).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'result-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveAck - real Postgres', () => {
  it('a_successful_send_writes_sent_at_one_wa_id_row_and_a_sent_event', async () => {
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
        outcome: { providerMsgId: 'wamid.ok' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('sent');
    expect(jobRow.sent_at).not.toBeNull();

    const waIdRows = await pool.query<{ direction: string; wa_msg_id: string }>(
      'SELECT direction, wa_msg_id FROM message_wa_ids WHERE client_id = $1 AND instance_id = $2',
      [seeded.clientId, seeded.instanceId],
    );
    expect(waIdRows.rows.length).toBe(1);
    expect(waIdRows.rows[0]?.direction).toBe('out');

    const eventRows = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1 AND event_type = $2',
      [seeded.jobId, 'sent'],
    );
    expect(eventRows.rows.length).toBe(1);
  });

  it('a_replayed_result_write_creates_no_second_delivery_event', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
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
      outcome: { providerMsgId: 'wamid.ok' },
      payloadKind: 'text',
      recipientJid: '15550000000@s.whatsapp.net',
    };

    await resolveAck(input, deps);
    // Replay: the job is no longer 'processing' (it is 'sent' now), so a
    // literal second resolveAck call would itself hit ClaimLostDuringSend
    // on the job-outcome UPDATE - the dedupe this test actually proves is
    // at the delivery_event_ids layer, exercised directly here the same
    // way a webhook replay would hit it.
    const { writeDeliveryEvent, deliveryEventId } = await import('./delivery-event.js');
    await tenantDb.withTenant(seeded.clientId, async (tx) => {
      const result = await writeDeliveryEvent(tx, {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        messageJobId: seeded.jobId,
        messageJobCreatedAt: seeded.jobCreatedAt,
        eventType: 'sent',
        providerEventId: deliveryEventId(
          seeded.instanceId,
          seeded.publicId,
          'sent',
          seeded.attemptNo,
        ),
      });
      expect(result.inserted).toBe(false);
    });

    const eventRows = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1 AND event_type = $2',
      [seeded.jobId, 'sent'],
    );
    expect(eventRows.rows.length).toBe(1);
  });

  it('a_zero_row_result_write_raises_claim_lost_during_send', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    let claimLostCount = 0;
    const deps: ResultDeps = { tenantDb, rng: fixedRng, onClaimLost: () => (claimLostCount += 1) };

    // Simulate the lease being stolen mid-send: another worker's re-claim
    // changed lease_id (message_jobs stays 'processing', but under a
    // DIFFERENT lease) - the job-outcome UPDATE's WHERE clause then matches
    // zero rows.
    await pool.query('UPDATE message_jobs SET lease_id = gen_random_uuid() WHERE id = $1', [
      seeded.jobId,
    ]);

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
          outcome: { providerMsgId: 'wamid.stolen' },
          payloadKind: 'text',
          recipientJid: '15550000000@s.whatsapp.net',
        },
        deps,
      ),
    ).rejects.toThrow(ClaimLostDuringSend);

    expect(claimLostCount).toBe(1);

    // The ack outcome is left on the attempt row - never re-sent.
    const attemptRow = await pool.query<{ state: string; provider_msg_id: string | null }>(
      'SELECT state, provider_msg_id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
      [seeded.jobId, seeded.attemptNo],
    );
    expect(attemptRow.rows[0]?.state).toBe('acked');
    expect(attemptRow.rows[0]?.provider_msg_id).toBe('wamid.stolen');

    // The job row itself was never touched by this call beyond the
    // lease-steal simulation above - still 'processing' (whatever the
    // other, real worker leaves it as is that worker's concern).
    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('processing');
  });

  it('an_ack_writes_and_increments_the_recipient_send_bucket_but_a_group_ack_writes_none', async () => {
    // P14 Unit U4, step 6: resolveAck's second tx upserts
    // recipient_send_buckets for a contact recipient, and writes NOTHING
    // for a group recipient (`recipientJid` ending `@g.us`).
    const seeded = await seedDispatchedAttempt(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    const phoneHash = Buffer.from('result-bucket-phone-hash-fixture');

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        outcome: { providerMsgId: 'wamid.bucket' },
        payloadKind: 'text',
        recipientHash: phoneHash,
        recipientJid: '15550009999@s.whatsapp.net',
      },
      deps,
    );

    const firstBucket = await pool.query<{ count: number }>(
      'SELECT count FROM recipient_send_buckets WHERE client_id = $1 AND phone_hash = $2',
      [seeded.clientId, phoneHash],
    );
    expect(firstBucket.rows).toEqual([{ count: 1 }]);

    // A second ack, SAME client/phone_hash within the same hour, increments
    // the existing row - never inserts a second one (PK
    // (client_id, phone_hash, hour_bucket)). A second job under the SAME
    // tenant (seedDispatchedAttempt always seeds a fresh tenant of its own).
    const jobTwo = await seedClaimedJob(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
    });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [seeded.clientId, seeded.instanceId, jobTwo.id, jobTwo.createdAt, jobTwo.leaseId],
    );

    await resolveAck(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: jobTwo.id,
        jobCreatedAt: jobTwo.createdAt,
        leaseId: jobTwo.leaseId,
        attemptNo: 1,
        publicId: jobTwo.publicId,
        outcome: { providerMsgId: 'wamid.bucket2' },
        payloadKind: 'text',
        recipientHash: phoneHash,
        recipientJid: '15550009999@s.whatsapp.net',
      },
      deps,
    );
    const afterSecond = await pool.query<{ count: number }>(
      'SELECT count FROM recipient_send_buckets WHERE client_id = $1 AND phone_hash = $2',
      [seeded.clientId, phoneHash],
    );
    expect(afterSecond.rows).toEqual([{ count: 2 }]);

    // A group ack writes NO bucket row at all.
    const groupSeeded = await seedDispatchedAttempt(pool, probeClientIds);
    const groupPhoneHash = Buffer.from('result-bucket-group-hash-fixture');
    await resolveAck(
      {
        clientId: groupSeeded.clientId,
        instanceId: groupSeeded.instanceId,
        jobId: groupSeeded.jobId,
        jobCreatedAt: groupSeeded.jobCreatedAt,
        leaseId: groupSeeded.leaseId,
        attemptNo: groupSeeded.attemptNo,
        publicId: groupSeeded.publicId,
        outcome: { providerMsgId: 'wamid.group' },
        payloadKind: 'text',
        recipientHash: groupPhoneHash,
        recipientJid: '123456-group@g.us',
      },
      deps,
    );
    const groupBucket = await pool.query(
      'SELECT 1 FROM recipient_send_buckets WHERE client_id = $1 AND phone_hash = $2',
      [groupSeeded.clientId, groupPhoneHash],
    );
    expect(groupBucket.rows.length).toBe(0);
  });
});
