import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createMetricsRegistry } from '@wp/server-kit';
import { OptOutCandidateText } from '@wp/domain';
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
  makeProvider,
  seedGroupSentJobWithWaId,
  cleanupReceiptsContactRows,
} from './__tests__/receipts-test-support.js';

/**
 * receipts-edge.integration.test.ts (P24 Unit U4b, step 8) - split out of
 * `receipts.integration.test.ts` at the max-lines cap (topic split only,
 * same fixture set): the structural "receipt path never consults the group
 * filter" proof, the `@lid`-only group-sender unattributable case, and the
 * `last_message_at` monotonic-touch case.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-receipts-edge-test',
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

describe('group receipts edge cases (real Postgres)', () => {
  it('the_receipt_path_never_consults_the_group_message_filter', async () => {
    const receiptsSource = readFileSync(
      path.resolve(__dirname, '..', 'inbound', 'receipts.ts'),
      'utf8',
    );
    const stampSource = readFileSync(
      path.resolve(__dirname, '..', 'inbound', 'receipts-campaign-stamp.ts'),
      'utf8',
    );
    const deliveryEventSource = readFileSync(
      path.resolve(__dirname, '..', '..', 'engine', 'queue', 'delivery-event.ts'),
      'utf8',
    );
    for (const source of [receiptsSource, stampSource, deliveryEventSource]) {
      expect(source.includes('sendEnabledGroupJids')).toBe(false);
    }

    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const groupJid = '120363500000000002@g.us';
    const waMsgId = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    await seedGroupSentJobWithWaId(pool, clientId, instanceId, groupJid, waMsgId);

    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);
    const receiptDeps = { tenantDb, clientId, instanceId, metrics };

    class ThrowingSet extends Set<string> {
      override has(): boolean {
        throw new Error('receipt path consulted the group set');
      }
    }
    const admission = { admit: async () => 'admitted' as const };
    const dispatcher = createInboundDispatcher({
      clientId,
      instanceId,
      admission,
      sendEnabledGroupJids: () => new ThrowingSet(),
      echo: async () => {},
      signals: async () => undefined,
      receipt: (r) => recordInboundReceipt(receiptDeps, r),
      deadLetter: async () => 'written' as const,
      metrics,
      logger: { warn: () => {} },
    });

    await expect(
      dispatcher.onMessageReceiptUpdate([
        {
          key: { fromMe: true, id: waMsgId, remoteJid: groupJid },
          receipt: { receiptTimestamp: 111 },
        },
      ]),
    ).resolves.toBeUndefined();

    const recorded = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1',
      [clientId],
    );
    expect(recorded.rows[0]?.count).toBe('1');

    // Toggle to a normal set mid-test - a second receipt is still recorded.
    const waMsgId2 = `3EB0${randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase()}`;
    await seedGroupSentJobWithWaId(pool, clientId, instanceId, groupJid, waMsgId2);
    const dispatcher2 = createInboundDispatcher({
      clientId,
      instanceId,
      admission,
      sendEnabledGroupJids: () => new Set<string>(),
      echo: async () => {},
      signals: async () => undefined,
      receipt: (r) => recordInboundReceipt(receiptDeps, r),
      deadLetter: async () => 'written' as const,
      metrics,
      logger: { warn: () => {} },
    });
    await dispatcher2.onMessageReceiptUpdate([
      {
        key: { fromMe: true, id: waMsgId2, remoteJid: groupJid },
        receipt: { receiptTimestamp: 222 },
      },
    ]);
    const recordedAfter = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM delivery_events WHERE client_id = $1',
      [clientId],
    );
    expect(recordedAfter.rows[0]?.count).toBe('2');
  });

  it('an_optout_from_a_lid_only_group_sender_is_recorded_as_unattributable', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const provider = makeProvider();
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const lidSenderDeps = {
      tenantDb,
      clientId,
      instanceId,
      keyProvider: provider,
      metrics,
      metricsRegistry: registry,
      mirror: async () => ({ contactsUpdated: 0 }),
      onOptedOut: async () => {},
    };

    const candidate = OptOutCandidateText.fromPlainText('STOP');
    if (candidate === null) throw new Error('expected a candidate');

    const outcome = await handleInboundMessageSignals(lidSenderDeps, {
      senderJid: '19998887777@lid',
      candidate,
      remoteJid: targetGroup.groupJid,
    });
    expect(outcome).toEqual({ attribution: 'unattributable', optedOut: false, touched: false });

    const optOutRows = await pool.query('SELECT id FROM opt_outs WHERE client_id = $1', [clientId]);
    expect(optOutRows.rowCount).toBe(0);

    const snapshot = await registry.metricsText();
    expect(snapshot).toMatch(/wp_optout_unattributable_total 1/);
  });

  it('a_group_message_that_passes_the_filter_touches_last_message_at', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const targetGroup = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const firstAt = new Date('2026-09-06T10:00:00.000Z');
    const outcomeFirst = await handleInboundMessageSignals(
      {
        tenantDb,
        clientId,
        instanceId,
        keyProvider: makeProvider(),
        metrics,
        mirror: async () => ({ contactsUpdated: 0 }),
        onOptedOut: async () => {},
        clock: { now: () => firstAt.getTime() },
      },
      { senderJid: '15550001111@s.whatsapp.net', candidate: null, remoteJid: targetGroup.groupJid },
    );
    expect(outcomeFirst.touched).toBe(true);

    const afterFirst = await readWaGroupState(pool, targetGroup.id);
    expect(afterFirst?.last_message_at?.toISOString()).toBe(firstAt.toISOString());

    // A second, OLDER message must not move it backwards.
    const olderAt = new Date('2026-09-06T09:00:00.000Z');
    await handleInboundMessageSignals(
      {
        tenantDb,
        clientId,
        instanceId,
        keyProvider: makeProvider(),
        metrics,
        mirror: async () => ({ contactsUpdated: 0 }),
        onOptedOut: async () => {},
        clock: { now: () => olderAt.getTime() },
      },
      { senderJid: '15550002222@s.whatsapp.net', candidate: null, remoteJid: targetGroup.groupJid },
    );

    const afterSecond = await readWaGroupState(pool, targetGroup.id);
    expect(afterSecond?.last_message_at?.toISOString()).toBe(firstAt.toISOString());
  });
});
