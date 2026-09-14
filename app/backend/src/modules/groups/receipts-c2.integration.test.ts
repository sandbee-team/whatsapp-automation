import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { bindInboundMetrics } from '../inbound/metrics.js';
import { recordInboundReceipt } from '../inbound/receipts.js';
import { cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  seedGroupSentJobWithWaId,
  groupDeliveredReceipt,
  cleanupReceiptsContactRows,
} from './__tests__/receipts-test-support.js';

/**
 * receipts-c2.integration.test.ts (P24 C2 test-engineer) - receipt-path edge
 * cases beyond `receipts.integration.test.ts`'s own 3-participant coverage:
 * 200 participant receipts for one message (huge but plausible), a receipt
 * whose participant jid is `@lid`-shaped (its own distinct id, never
 * collapsed with the `@s.whatsapp.net` spelling of the same user), and a
 * receipt for a group message we never sent (unknown `wa_msg_id`) - pinning
 * the existing ignored-without-dead-letter contract.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-receipts-c2-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupReceiptsContactRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group receipts c2 - 200 participants on one message', () => {
  it('200_participant_receipts_for_one_message_write_200_rows_no_duplicate_no_dead_letter', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const groupJid = '120363950000000001@g.us';
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const { jobId } = await seedGroupSentJobWithWaId(pool, clientId, instanceId, groupJid, waMsgId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const participants = Array.from(
      { length: 200 },
      (_, i) => `91990${String(i).padStart(7, '0')}@s.whatsapp.net`,
    );

    for (const participantJid of participants) {
      const outcome = await recordInboundReceipt(
        deps,
        groupDeliveredReceipt(waMsgId, groupJid, participantJid),
      );
      expect(outcome).toBe('recorded');
    }

    const eventRows = await pool.query<{ id: string }>(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(eventRows.rows).toHaveLength(200);
    expect(new Set(eventRows.rows.map((r) => r.id)).size).toBe(200);

    const idRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_event_ids WHERE client_id = $1',
      [clientId],
    );
    expect(Number(idRows.rows[0]?.count)).toBeGreaterThanOrEqual(200);

    const deadLetters = await tenantDb.withTenant(clientId, (tx) =>
      tx.query('SELECT count(*) AS n FROM inbound_dead_letters WHERE client_id = $1', [clientId]),
    );
    expect(Number(deadLetters.rows[0]?.n)).toBe(0);

    // Replaying one of the 200 writes no 201st row.
    const replay = await recordInboundReceipt(
      deps,
      groupDeliveredReceipt(waMsgId, groupJid, participants[0]!),
    );
    expect(replay).toBe('duplicate');
    const afterReplay = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    expect(afterReplay.rows[0]?.count).toBe('200');
  });
});

describe('group receipts c2 - an @lid-shaped participant', () => {
  it('a_receipt_whose_participant_jid_is_lid_shaped_gets_its_own_distinct_id_from_the_s_whatsapp_net_spelling', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const groupJid = '120363950000000002@g.us';
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const { jobId } = await seedGroupSentJobWithWaId(pool, clientId, instanceId, groupJid, waMsgId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const lidParticipant = '19998887777@lid';
    const phoneParticipant = '19998887777@s.whatsapp.net';

    const outcomeLid = await recordInboundReceipt(
      deps,
      groupDeliveredReceipt(waMsgId, groupJid, lidParticipant),
    );
    expect(outcomeLid).toBe('recorded');

    const outcomePhone = await recordInboundReceipt(
      deps,
      groupDeliveredReceipt(waMsgId, groupJid, phoneParticipant),
    );
    expect(outcomePhone).toBe('recorded');

    const eventRows = await pool.query<{ id: string }>(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, jobId],
    );
    // Even though the two jids carry the identical digit string, the @lid
    // and @s.whatsapp.net spellings are DIFFERENT identities to WhatsApp -
    // the event-id hash must never collapse them into one row.
    expect(eventRows.rows).toHaveLength(2);
    expect(new Set(eventRows.rows.map((r) => r.id)).size).toBe(2);
  });
});

describe('group receipts c2 - unknown wa_msg_id', () => {
  it('a_receipt_for_a_group_message_we_never_sent_is_ignored_without_dead_letter_noise', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const groupJid = '120363950000000003@g.us';
    const unknownWaMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const outcome = await recordInboundReceipt(
      deps,
      groupDeliveredReceipt(unknownWaMsgId, groupJid, 'x@s.whatsapp.net'),
    );
    // Pins the existing P21 contract: an unmatched wa_msg_id is reported as
    // 'unmatched' and writes no delivery_events row and no dead letter -
    // never a thrown error, never a silent dead-letter.
    expect(outcome).toBe('unmatched');

    const eventRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1',
      [clientId],
    );
    expect(eventRows.rows[0]?.count).toBe('0');

    const deadLetters = await tenantDb.withTenant(clientId, (tx) =>
      tx.query('SELECT count(*) AS n FROM inbound_dead_letters WHERE client_id = $1', [clientId]),
    );
    expect(Number(deadLetters.rows[0]?.n)).toBe(0);
  });
});
