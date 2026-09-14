import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { receiptProviderEventId } from '../../engine/queue/delivery-event.js';
import { bindInboundMetrics } from './metrics.js';
import {
  receiptsFromMessagesUpdate,
  receiptsFromReceiptUpdate,
  recordInboundReceipt,
  type RecordReceiptDeps,
} from './receipts.js';

/**
 * receipts.test.ts (P21 Unit U3, step 4) - pure-logic proof of the two
 * Baileys event parsers plus `recordInboundReceipt` against a fake
 * `TenantDb`/`TenantQueryable` (no real Postgres - that proof lives in
 * receipts.integration.test.ts). Every case here is deterministic: no
 * sleeps, no live clock, exact expected values only.
 */

describe('receiptsFromMessagesUpdate', () => {
  it('messages_update_statuses_map_to_receipt_events', () => {
    const payload = [
      { key: { fromMe: true, id: 'MSG-3', remoteJid: 'a@s.whatsapp.net' }, update: { status: 3 } },
      { key: { fromMe: true, id: 'MSG-4', remoteJid: 'a@s.whatsapp.net' }, update: { status: 4 } },
      { key: { fromMe: true, id: 'MSG-5', remoteJid: 'a@s.whatsapp.net' }, update: { status: 5 } },
      { key: { fromMe: true, id: 'MSG-0', remoteJid: 'a@s.whatsapp.net' }, update: { status: 0 } },
      { key: { fromMe: true, id: 'MSG-1', remoteJid: 'a@s.whatsapp.net' }, update: { status: 1 } },
      { key: { fromMe: true, id: 'MSG-2', remoteJid: 'a@s.whatsapp.net' }, update: { status: 2 } },
      {
        key: { fromMe: false, id: 'MSG-NOT-MINE', remoteJid: 'a@s.whatsapp.net' },
        update: { status: 3 },
      },
      { key: { fromMe: true, remoteJid: 'a@s.whatsapp.net' }, update: { status: 3 } },
    ];

    const receipts = receiptsFromMessagesUpdate(payload);

    expect(receipts).toEqual([
      {
        waMsgId: 'MSG-3',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'delivered',
        eventTs: '',
        participantJid: '',
      },
      {
        waMsgId: 'MSG-4',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'read',
        eventTs: '',
        participantJid: '',
      },
      {
        waMsgId: 'MSG-5',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'read',
        eventTs: '',
        participantJid: '',
      },
      {
        waMsgId: 'MSG-0',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'failed',
        eventTs: '',
        participantJid: '',
      },
    ]);
  });
});

describe('receiptsFromReceiptUpdate', () => {
  it('receipt_update_prefers_read_over_delivered_and_keeps_participant_for_groups_only', () => {
    const dmPayload = [
      {
        key: { fromMe: true, id: 'MSG-DM', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', receiptTimestamp: 1000 },
      },
    ];
    expect(receiptsFromReceiptUpdate(dmPayload)).toEqual([
      {
        waMsgId: 'MSG-DM',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'delivered',
        eventTs: '1000',
        participantJid: '',
      },
    ]);

    const groupPayload = [
      {
        key: { fromMe: true, id: 'MSG-GROUP', remoteJid: 'g@g.us' },
        receipt: { userJid: 'member@s.whatsapp.net', receiptTimestamp: 1000 },
      },
    ];
    expect(receiptsFromReceiptUpdate(groupPayload)).toEqual([
      {
        waMsgId: 'MSG-GROUP',
        remoteJid: 'g@g.us',
        eventType: 'delivered',
        eventTs: '1000',
        participantJid: 'member@s.whatsapp.net',
      },
    ]);

    const readAndDelivered = [
      {
        key: { fromMe: true, id: 'MSG-READ', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', readTimestamp: 2000, receiptTimestamp: 1000 },
      },
    ];
    expect(receiptsFromReceiptUpdate(readAndDelivered)).toEqual([
      {
        waMsgId: 'MSG-READ',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'read',
        eventTs: '2000',
        participantJid: '',
      },
    ]);

    const longLikeTimestamp = [
      {
        key: { fromMe: true, id: 'MSG-LONG', remoteJid: 'a@s.whatsapp.net' },
        receipt: {
          userJid: 'a@s.whatsapp.net',
          receiptTimestamp: { low: 1725000000, high: 0, unsigned: false },
        },
      },
    ];
    expect(receiptsFromReceiptUpdate(longLikeTimestamp)).toEqual([
      {
        waMsgId: 'MSG-LONG',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'delivered',
        eventTs: '1725000000',
        participantJid: '',
      },
    ]);
  });
});

describe('receiptProviderEventId', () => {
  it('receipt_provider_event_id_is_deterministic_and_distinct_per_event_type', () => {
    const a = receiptProviderEventId('instance-1', 'MSG-1', 'delivered', '1000', '');
    const b = receiptProviderEventId('instance-1', 'MSG-1', 'delivered', '1000', '');
    const readVariant = receiptProviderEventId('instance-1', 'MSG-1', 'read', '1000', '');
    const participantVariant = receiptProviderEventId(
      'instance-1',
      'MSG-1',
      'delivered',
      '1000',
      'member@s.whatsapp.net',
    );

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(readVariant);
    expect(a).not.toBe(participantVariant);
  });
});

interface FakeQuery {
  sql: string;
  params: unknown[];
}

function makeFakeTenantDb(options: {
  matchedRow: { message_id: string; message_created_at_text: string } | null;
  dedupeRowCount: number;
}): { tenantDb: RecordReceiptDeps['tenantDb']; calls: FakeQuery[] } {
  const calls: FakeQuery[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT message_id')) {
        return options.matchedRow
          ? { rows: [options.matchedRow], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO delivery_event_ids')) {
        return { rows: [], rowCount: options.dedupeRowCount };
      }
      if (sql.includes('INSERT INTO delivery_events')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE campaign_recipients')) {
        // Never a campaign job in these tests - matches zero rows.
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`makeFakeTenantDb: unexpected query: ${sql}`);
    }),
  };
  const tenantDb = {
    withTenant: vi.fn(async (_clientId: string, callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  } as unknown as RecordReceiptDeps['tenantDb'];
  return { tenantDb, calls };
}

function makeDeps(
  tenantDb: RecordReceiptDeps['tenantDb'],
  metrics = bindInboundMetrics(createMetricsRegistry()),
): RecordReceiptDeps {
  return { tenantDb, clientId: 'client-1', instanceId: 'instance-1', metrics };
}

describe('recordInboundReceipt', () => {
  it('an_unknown_wa_msg_id_is_counted_and_never_throws', async () => {
    const { tenantDb, calls } = makeFakeTenantDb({ matchedRow: null, dedupeRowCount: 1 });
    const deps = makeDeps(tenantDb);
    const metrics = deps.metrics;

    const outcome = await recordInboundReceipt(deps, {
      waMsgId: 'MSG-UNKNOWN',
      remoteJid: 'a@s.whatsapp.net',
      eventType: 'delivered',
      eventTs: '',
      participantJid: '',
    });

    expect(outcome).toBe('unmatched');
    expect((await metrics.receiptUnmatchedTotal.get()).values[0]?.value).toBe(1);
    expect(calls.some((call) => call.sql.includes('INSERT INTO delivery_events'))).toBe(false);
  });

  it('a_matched_receipt_writes_the_pair_once_and_a_replay_is_a_duplicate', async () => {
    const matchedRow = { message_id: '42', message_created_at_text: '2026-01-01 00:00:00+00' };
    const { tenantDb, calls } = makeFakeTenantDb({ matchedRow, dedupeRowCount: 1 });
    const deps = makeDeps(tenantDb);
    const metrics = deps.metrics;
    const receipt = {
      waMsgId: 'MSG-MATCHED',
      remoteJid: 'group@g.us',
      eventType: 'delivered' as const,
      eventTs: '1000',
      participantJid: 'member@s.whatsapp.net',
    };

    const first = await recordInboundReceipt(deps, receipt);
    expect(first).toBe('recorded');
    expect((await metrics.receiptsTotal.get()).values[0]?.value).toBe(1);

    const insertCalls = calls.filter(
      (call) =>
        call.sql.includes('INSERT INTO delivery_event_ids') ||
        call.sql.includes('INSERT INTO delivery_events'),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0]?.sql).toContain('INSERT INTO delivery_event_ids');
    expect(insertCalls[1]?.sql).toContain('INSERT INTO delivery_events');

    // Funnel stamp runs once, right after the fresh insert.
    const stampCalls = calls.filter((call) => call.sql.includes('UPDATE campaign_recipients'));
    expect(stampCalls).toHaveLength(1);
    expect(calls.at(-1)?.sql).toContain('UPDATE campaign_recipients');

    for (const call of calls) {
      for (const param of call.params) {
        if (typeof param === 'string') {
          expect(param).not.toContain('member@s.whatsapp.net');
          expect(param).not.toContain('group@g.us');
        }
      }
    }

    // Replay: dedupe insert now reports rowCount 0 (already recorded).
    const { tenantDb: replayTenantDb, calls: replayCalls } = makeFakeTenantDb({
      matchedRow,
      dedupeRowCount: 0,
    });
    const replayDeps = makeDeps(replayTenantDb, metrics);

    const second = await recordInboundReceipt(replayDeps, receipt);
    expect(second).toBe('duplicate');
    expect(replayCalls.some((call) => call.sql.includes('INSERT INTO delivery_events'))).toBe(
      false,
    );
    expect(replayCalls.some((call) => call.sql.includes('UPDATE campaign_recipients'))).toBe(false);
  });

  it('a_duplicate_receipt_increments_inbound_id_collision_total', async () => {
    const matchedRow = { message_id: '43', message_created_at_text: '2026-01-01 00:00:00+00' };
    const { tenantDb } = makeFakeTenantDb({ matchedRow, dedupeRowCount: 0 });
    const deps = makeDeps(tenantDb);
    const metrics = deps.metrics;

    const outcome = await recordInboundReceipt(deps, {
      waMsgId: 'MSG-DUP',
      remoteJid: 'a@s.whatsapp.net',
      eventType: 'delivered',
      eventTs: '',
      participantJid: '',
    });

    expect(outcome).toBe('duplicate');
    expect((await metrics.inboundIdCollisionTotal.get()).values[0]?.value).toBe(1);
  });
});
