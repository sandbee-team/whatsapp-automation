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
import {
  receiptsFromMessagesUpdate,
  receiptsFromReceiptUpdate,
  recordInboundReceipt,
  type InboundReceipt,
} from './receipts.js';
import { seedJobRef } from './__tests__/optout-inbound-test-support.js';

/**
 * receipts-edge.integration.test.ts (P21 E3 hardening) - real Postgres
 * proofs beyond the sibling `receipts.integration.test.ts`: 20 concurrent
 * identical delivered receipts collapse to exactly one row, a receipt for a
 * job whose `message_wa_ids.message_id IS NULL` (an unresolved echo row) is
 * 'unmatched' with no row written, and a receipt whose `wa_msg_id` exists
 * under ANOTHER tenant is 'unmatched' under THIS tenant (tenant isolation,
 * never cross-tenant matched).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'inbound-receipts-edge-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function deliveredReceipt(waMsgId: string): InboundReceipt {
  return {
    waMsgId,
    remoteJid: 'a@s.whatsapp.net',
    eventType: 'delivered',
    eventTs: '1000',
    participantJid: '',
  };
}

async function seedSentJobWithWaId(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
): Promise<{ jobId: string; waMsgId: string }> {
  const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const jobResult = await testPool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, sent_at)
     VALUES ($1, $2, 0, $3, $4, $5, $6, 'text', 'normal', 3, 'sent', now(), now(), 1, 5, $7)
     RETURNING id`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      '+15550001234',
      Buffer.from('probe-hash'),
      JSON.stringify({ text: 'hello' }),
      twoHoursAgo,
    ],
  );
  const jobRow = jobResult.rows[0];
  if (!jobRow) throw new Error('seedSentJobWithWaId: no message_jobs row returned');
  await seedJobRef(testPool, clientId, instanceId, jobRow.id);

  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     SELECT $1, $2, 'out', $3, j.id, j.created_at, now()
       FROM message_jobs j WHERE j.id = $4`,
    [clientId, instanceId, waMsgId, jobRow.id],
  );

  return { jobId: jobRow.id, waMsgId };
}

/** An 'out' message_wa_ids row with message_id IS NULL - an echo capture that arrived before its own send-result write resolved the job (P12's own documented "unresolved attempt" shape). */
async function seedUnresolvedEchoRow(
  testPool: TestPool,
  clientId: string,
  instanceId: string,
): Promise<string> {
  const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
  await testPool.query(
    `INSERT INTO message_wa_ids
       (client_id, instance_id, direction, wa_msg_id, message_id, message_created_at, observed_at)
     VALUES ($1, $2, 'out', $3, NULL, NULL, now())`,
    [clientId, instanceId, waMsgId],
  );
  return waMsgId;
}

describe('receipt handler edge cases (real Postgres)', () => {
  it('twenty_concurrent_identical_delivered_receipts_collapse_to_exactly_one_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const { jobId, waMsgId } = await seedSentJobWithWaId(pool, clientId, instanceId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => recordInboundReceipt(deps, deliveredReceipt(waMsgId))),
    );

    expect(outcomes.filter((o) => o === 'recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(19);

    const rows = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(rows.rowCount).toBe(1);
  }, 30_000);

  it('a_receipt_for_an_unresolved_echo_row_with_a_null_message_id_is_unmatched_with_no_row_written', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const waMsgId = await seedUnresolvedEchoRow(pool, clientId, instanceId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcome = await recordInboundReceipt(deps, deliveredReceipt(waMsgId));

    expect(outcome).toBe('unmatched');
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);
    const events = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      clientId,
    ]);
    expect(events.rowCount).toBe(0);
  });

  it('a_wa_msg_id_that_exists_under_another_tenant_is_unmatched_under_this_tenant', async () => {
    const tenantA = await seedSendTenant(pool, probeClientIds);
    const tenantB = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);

    // A real, resolvable send-result row exists for tenant A's wa_msg_id.
    const { waMsgId } = await seedSentJobWithWaId(pool, tenantA.clientId, tenantA.instanceId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    // Tenant B's receipt handler looks up the SAME wa_msg_id but scoped to
    // tenant B's own (clientId, instanceId) - the query's WHERE clause is
    // client_id/instance_id-scoped, so this must never cross-match A's row.
    const outcome = await recordInboundReceipt(
      { tenantDb, clientId: tenantB.clientId, instanceId: tenantB.instanceId, metrics },
      deliveredReceipt(waMsgId),
    );

    expect(outcome).toBe('unmatched');
    const crossTenantEvents = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1',
      [tenantB.clientId],
    );
    expect(crossTenantEvents.rowCount).toBe(0);
    // Tenant A's own row remains completely untouched by tenant B's failed lookup.
    const tenantAEvents = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      tenantA.clientId,
    ]);
    expect(tenantAEvents.rowCount).toBe(0);
  });

  it('a_delivered_messages_update_then_a_delivered_message_receipt_update_for_the_same_dm_write_exactly_one_row_against_real_postgres', async () => {
    // Identity decision proof against real Postgres: (instance_id,
    // wa_msg_id, event_type, participant_jid) - eventTs excluded. A
    // `messages.update` delivered receipt (eventTs='') followed by a
    // `message-receipt.update` delivered receipt (real provider eventTs)
    // for the SAME wa_msg_id must collapse to ONE delivery_events row and
    // exactly one `wp_receipts_total{event_type="delivered"}` increment.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const tenantDb = createTenantDb(pool);
    const { jobId, waMsgId } = await seedSentJobWithWaId(pool, clientId, instanceId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const fromMessagesUpdate = receiptsFromMessagesUpdate([
      { key: { fromMe: true, id: waMsgId, remoteJid: 'a@s.whatsapp.net' }, update: { status: 3 } },
    ])[0]!;
    const fromReceiptUpdate = receiptsFromReceiptUpdate([
      {
        key: { fromMe: true, id: waMsgId, remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', receiptTimestamp: 1700000000 },
      },
    ])[0]!;

    const outcome1 = await recordInboundReceipt(deps, fromMessagesUpdate);
    const outcome2 = await recordInboundReceipt(deps, fromReceiptUpdate);

    expect(outcome1).toBe('recorded');
    expect(outcome2).toBe('duplicate');

    const rows = await pool.query(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(rows.rowCount).toBe(1);

    expect(
      (await metrics.receiptsTotal.get()).values.find((v) => v.labels.event_type === 'delivered')
        ?.value,
    ).toBe(1);
  });
});
