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
import { handleInboundMessageSignals } from '../inbound/message-signals.js';
import { createInboundDispatcher } from '../inbound/handler.js';
import { seedWaGroup, cleanupWaGroups, readWaGroupState } from './__tests__/groups-test-helpers.js';
import {
  seedMinimalCampaign,
  seedCampaignRecipientGroup,
  cleanupForbiddenTestCampaigns,
} from './__tests__/forbidden-test-helpers.js';
import {
  makeProvider,
  seedSentJobWithWaId,
  seedGroupSentJobWithWaId,
  groupDeliveredReceipt,
  dmDeliveredReceipt,
  cleanupReceiptsContactRows,
} from './__tests__/receipts-test-support.js';

/**
 * receipts.integration.test.ts (P24 Unit U4b, step 8) - real Postgres proof
 * that a group receipt carries the participant into its own dedupe identity
 * distinctly from a DM receipt on the same `wa_msg_id` string, and is never
 * filtered by the message-scope group allow-list. The structural "receipt
 * path never consults the group filter" scan, the `@lid`-unattributable
 * case, and the `last_message_at` monotonic-touch case live in
 * `receipts-edge.integration.test.ts` (max-lines split, same suite/fixtures).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-receipts-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupForbiddenTestCampaigns(pool, probeClientIds);
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupReceiptsContactRows(pool, probeClientIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('group receipts (real Postgres)', () => {
  it('group_receipt_ids_include_participant_and_do_not_collide_with_dm_receipts', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const groupJid = '120363500000000001@g.us';
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const { jobId: groupJobId } = await seedGroupSentJobWithWaId(
      pool,
      clientId,
      instanceId,
      groupJid,
      waMsgId,
    );

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const deps = { tenantDb, clientId, instanceId, metrics };

    const participants = ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net'];
    for (const participantJid of participants) {
      const outcome = await recordInboundReceipt(
        deps,
        groupDeliveredReceipt(waMsgId, groupJid, participantJid),
      );
      expect(outcome).toBe('recorded');
    }

    const groupIdRows = await pool.query<{ provider_event_id: string }>(
      'SELECT provider_event_id FROM delivery_event_ids WHERE client_id = $1',
      [clientId],
    );
    const groupEventRows = await pool.query<{ id: string }>(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, groupJobId],
    );
    expect(groupEventRows.rows).toHaveLength(3);

    // A DIFFERENT instance's DM job with the identical wa_msg_id string.
    const { instanceId: otherInstanceId } = await seedSendTenant(pool, probeClientIds);
    const { jobId: dmJobId } = await seedSentJobWithWaId(pool, clientId, otherInstanceId, waMsgId);
    const dmOutcome = await recordInboundReceipt(
      { tenantDb, clientId, instanceId: otherInstanceId, metrics },
      dmDeliveredReceipt(waMsgId),
    );
    expect(dmOutcome).toBe('recorded');

    const totalRows = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1',
      [clientId],
    );
    expect(totalRows.rows[0]?.count).toBe('4');
    expect(groupIdRows.rows.length).toBeGreaterThan(0);

    // The DM's own delivery_events row is distinct from every group row -
    // no id collision even though the wa_msg_id string is identical.
    const dmEventRows = await pool.query<{ id: string }>(
      'SELECT id FROM delivery_events WHERE client_id = $1 AND message_job_id = $2',
      [clientId, dmJobId],
    );
    expect(dmEventRows.rows).toHaveLength(1);
    const groupEventIds = new Set(groupEventRows.rows.map((row) => row.id));
    expect(groupEventIds.has(dmEventRows.rows[0]!.id)).toBe(false);

    // Replaying one participant receipt writes no 5th row.
    const replay = await recordInboundReceipt(
      deps,
      groupDeliveredReceipt(waMsgId, groupJid, participants[0]!),
    );
    expect(replay).toBe('duplicate');
    const afterReplay = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1',
      [clientId],
    );
    expect(afterReplay.rows[0]?.count).toBe('4');
  });

  it('group_send_receipts_are_never_filtered_by_the_message_ignore_rule', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const campaignId = await seedMinimalCampaign(pool, { clientId, instanceId });
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    const { publicId } = await seedGroupSentJobWithWaId(
      pool,
      clientId,
      instanceId,
      targetGroup.groupJid,
      waMsgId,
    );
    await seedCampaignRecipientGroup(pool, {
      clientId,
      campaignId,
      groupId: targetGroup.id,
      groupJid: targetGroup.groupJid,
      messageJobPublicId: publicId,
    });

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const receiptDeps = { tenantDb, clientId, instanceId, metrics };

    // The group is NOT in the send-enabled set at dispatcher-level (empty
    // Set) - receipts must still be recorded regardless.
    const emptySet = new Set<string>();
    const admission = { admit: async () => 'admitted' as const };
    const dispatcher = createInboundDispatcher({
      clientId,
      instanceId,
      admission,
      sendEnabledGroupJids: () => emptySet,
      echo: async () => {},
      signals: async () =>
        handleInboundMessageSignals(
          {
            tenantDb,
            clientId,
            instanceId,
            keyProvider: makeProvider(),
            metrics,
            mirror: async () => ({ contactsUpdated: 0 }),
            onOptedOut: async () => {},
          },
          { senderJid: 'x@s.whatsapp.net', candidate: null, remoteJid: targetGroup.groupJid },
        ),
      receipt: (r) => recordInboundReceipt(receiptDeps, r),
      deadLetter: async () => 'written' as const,
      metrics,
      logger: { warn: () => {} },
    });

    await dispatcher.onMessageReceiptUpdate([
      {
        key: { fromMe: true, id: waMsgId, remoteJid: targetGroup.groupJid },
        receipt: { receiptTimestamp: 111 },
      },
      {
        key: { fromMe: true, id: waMsgId, remoteJid: targetGroup.groupJid },
        receipt: { readTimestamp: 222 },
      },
    ]);

    const recipientRow = await pool.query<{ delivered_at: Date | null; read_at: Date | null }>(
      'SELECT delivered_at, read_at FROM campaign_recipients WHERE client_id = $1 AND group_id = $2',
      [clientId, targetGroup.id],
    );
    expect(recipientRow.rows[0]?.delivered_at).not.toBeNull();
    expect(recipientRow.rows[0]?.read_at).not.toBeNull();

    // An inbound group MESSAGE from that same (not-send-enabled) group is
    // dropped by the message scope filter - no dead letter, no last_message_at.
    await dispatcher.onMessagesUpsert({
      messages: [
        {
          key: { fromMe: false, id: 'wamid-dropped-1', remoteJid: targetGroup.groupJid },
        },
      ],
      type: 'notify',
    });

    const deadLetters = await tenantDb.withTenant(clientId, (tx) =>
      tx.query('SELECT count(*) AS n FROM inbound_dead_letters WHERE client_id = $1', [clientId]),
    );
    expect(Number(deadLetters.rows[0]?.n)).toBe(0);

    const groupState = await readWaGroupState(pool, targetGroup.id);
    expect(groupState?.last_message_at).toBeNull();

    const scanColumns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ANY($1)
          AND (data_type IN ('text','character varying','json','jsonb') OR data_type = 'ARRAY')`,
      [['inbound_dead_letters', 'delivery_events', 'campaign_recipients']],
    );
    for (const { table_name: tableName, column_name: columnName } of scanColumns.rows) {
      if (columnName === 'vars' || columnName === 'metadata') continue; // opaque snapshot/audit fields, not a "body" column.
      const hit = await pool.query(
        `SELECT 1 FROM ${tableName} WHERE client_id = $1 AND ${columnName}::text LIKE $2 LIMIT 1`,
        [clientId, '%hello group%'],
      );
      expect(hit.rowCount, `${tableName}.${columnName} unexpectedly carried the message body`).toBe(
        0,
      );
    }
  });
});
