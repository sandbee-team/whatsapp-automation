import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
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
 * receipts-c2.integration.test.ts (P21 C2 hardening) - real-Postgres cases
 * the E3 pass did not cover: the SAME `wa_msg_id` under TWO DIFFERENT
 * instances of one client resolves to two independent jobs and writes two
 * rows (the PK is `(client_id, instance_id, direction, wa_msg_id)`); a
 * retry-storm replay of one receipt 50 times writes exactly one row with 49
 * exact duplicates; and a receipt whose `message_wa_ids` row is resolved
 * BETWEEN two attempts (first unmatched, then a P12-style resolution sets
 * `message_id`) proves the first attempt's signal is genuinely lost -
 * documented as the accepted behaviour with an exact assertion.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'receipts-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedSentJobWithWaId(
  clientId: string,
  instanceId: string,
  waMsgId: string,
): Promise<string> {
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, now())
     RETURNING id`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      '+15550001234',
      Buffer.from('probe-hash'),
      JSON.stringify({ text: 'hello' }),
    ],
  );
  const jobId = jobResult.rows[0]?.id;
  if (!jobId) throw new Error('seedSentJobWithWaId: no message_jobs row returned');
  await seedJobRef(pool, clientId, instanceId, jobId);

  await pool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4`,
    [clientId, instanceId, waMsgId, jobId],
  );
  return jobId;
}

function deliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1',
    participantJid: '',
  };
}

describe('recordInboundReceipt - same wa_msg_id under two instances of one client (real Postgres)', () => {
  it('the_same_wa_msg_id_reused_across_two_instances_resolves_to_two_independent_jobs_and_writes_two_rows', async () => {
    const { clientId, instanceId: instanceA } = await seedSendTenant(pool, probeClientIds);
    const { instanceId: instanceB } = await seedSendTenant(pool, probeClientIds);
    const sharedWaMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;

    const jobIdA = await seedSentJobWithWaId(clientId, instanceA, sharedWaMsgId);
    const jobIdB = await seedSentJobWithWaId(clientId, instanceB, sharedWaMsgId);
    expect(jobIdA).not.toBe(jobIdB);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const outcomeA = await recordInboundReceipt(
      { tenantDb, clientId, instanceId: instanceA, metrics },
      deliveredReceipt(sharedWaMsgId),
    );
    const outcomeB = await recordInboundReceipt(
      { tenantDb, clientId, instanceId: instanceB, metrics },
      deliveredReceipt(sharedWaMsgId),
    );
    expect(outcomeA).toBe('recorded');
    expect(outcomeB).toBe('recorded');

    const rowsA = await pool.query<{
      id: string;
      message_job_id: string;
      provider_event_id: string;
    }>(
      'SELECT id, message_job_id, provider_event_id FROM delivery_events WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceA],
    );
    const rowsB = await pool.query<{
      id: string;
      message_job_id: string;
      provider_event_id: string;
    }>(
      'SELECT id, message_job_id, provider_event_id FROM delivery_events WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceB],
    );
    expect(rowsA.rowCount).toBe(1);
    expect(rowsB.rowCount).toBe(1);
    expect(rowsA.rows[0]?.message_job_id).toBe(jobIdA);
    expect(rowsB.rows[0]?.message_job_id).toBe(jobIdB);
    expect(rowsA.rows[0]?.provider_event_id).not.toBe(rowsB.rows[0]?.provider_event_id);

    const totalRows = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      clientId,
    ]);
    expect(totalRows.rowCount).toBe(2);
  });
});

describe('recordInboundReceipt - retry storm (real Postgres)', () => {
  it('the_same_delivered_receipt_replayed_50_times_writes_exactly_one_row_and_49_are_duplicate', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const jobId = await seedSentJobWithWaId(clientId, instanceId, waMsgId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
      outcomes.push(await recordInboundReceipt(deps, deliveredReceipt(waMsgId)));
    }

    expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(49);

    const rows = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(rows.rowCount).toBe(1);

    expect(
      (await metrics.receiptsTotal.get()).values.find((v) => v.labels.event_type === 'delivered')
        ?.value,
    ).toBe(1);
  }, 30_000);
});

describe('recordInboundReceipt - a receipt resolved BETWEEN two attempts (real Postgres)', () => {
  it('the_first_unmatched_receipt_is_genuinely_lost_once_the_wa_msg_id_row_is_later_resolved', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;

    // Row exists (P12's echo-capture wrote it) but message_id is still NULL
    // - a not-yet-resolved echo, the exact P12 "unresolved attempt" shape.
    await pool.query(
      `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
       VALUES ($1, $2, 'out', $3, NULL, NULL, now())`,
      [clientId, instanceId, waMsgId],
    );

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const firstAttempt = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    expect(firstAttempt).toBe('unmatched');
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);

    // P12-style resolution: the row is later updated to carry a real
    // message_id (the reconciler matched the echo to its message_jobs row).
    const jobResult = await pool.query<{ id: string }>(
      `INSERT INTO message_jobs
         (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
          payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
          attempts, max_attempts, sent_at)
       VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, now())
       RETURNING id`,
      [
        clientId,
        instanceId,
        `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
        '+15550001234',
        Buffer.from('probe-hash'),
        JSON.stringify({ text: 'hello' }),
      ],
    );
    const jobId = jobResult.rows[0]?.id;
    if (!jobId) throw new Error('no message_jobs row returned');
    await seedJobRef(pool, clientId, instanceId, jobId);
    await pool.query(
      `UPDATE message_wa_ids SET message_id = $3, message_created_at = (SELECT created_at FROM message_jobs WHERE id = $3)
        WHERE client_id = $1 AND instance_id = $2 AND direction = 'out' AND wa_msg_id = $4`,
      [clientId, instanceId, jobId, waMsgId],
    );

    // The FIRST attempt's 'delivered' fact is genuinely lost: nothing
    // re-drives it once the row resolves. Documented, not "fixed" here - the
    // exact counter/row state after resolution proves the loss precisely.
    const rowsAfterResolution = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(rowsAfterResolution.rowCount).toBe(0);

    // A SECOND identical receipt arriving AFTER resolution (e.g. WhatsApp's
    // own retry of the delivery receipt) IS captured normally, since
    // resolution has already happened by then.
    const secondAttempt = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));
    expect(secondAttempt).toBe('recorded');
    const rowsAfterSecond = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(rowsAfterSecond.rowCount).toBe(1);

    // Unmatched counter stays at exactly 1 - the one lost attempt, never
    // incremented again for the same logical fact.
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);
  });
});
