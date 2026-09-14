import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindInboundMetrics } from './metrics.js';
import {
  receiptsFromMessagesUpdate,
  receiptsFromReceiptUpdate,
  recordInboundReceipt,
  timestampToString,
  type RecordReceiptDeps,
} from './receipts.js';

/**
 * receipts-edge.test.ts (P21 E3 hardening) - adversarial status codes,
 * Long-typed timestamps, group-participant edge cases, and the
 * messages.update-vs-message-receipt.update double-row question for the
 * receipt handler, beyond the sibling `receipts.test.ts`.
 */

describe('receiptsFromMessagesUpdate edge status codes', () => {
  it('a_string_status_of_3_is_not_a_number_and_is_skipped', () => {
    const payload = [
      {
        key: { fromMe: true, id: 'MSG-1', remoteJid: 'a@s.whatsapp.net' },
        update: { status: '3' },
      },
    ];
    // receiptEventTypeFromStatus does `status === 3` (strict equality) - a
    // string '3' never matches, so this entry is dropped entirely.
    expect(receiptsFromMessagesUpdate(payload as unknown)).toEqual([]);
  });

  it('a_negative_status_and_an_unknown_status_of_6_are_both_skipped', () => {
    const payload = [
      {
        key: { fromMe: true, id: 'MSG-NEG', remoteJid: 'a@s.whatsapp.net' },
        update: { status: -1 },
      },
      { key: { fromMe: true, id: 'MSG-6', remoteJid: 'a@s.whatsapp.net' }, update: { status: 6 } },
    ];
    expect(receiptsFromMessagesUpdate(payload)).toEqual([]);
  });
});

describe('timestampToString edge cases', () => {
  it('a_long_like_value_with_a_toNumber_function_uses_it', () => {
    const longLike = { low: 123, high: 0, toNumber: () => 456 };
    expect(timestampToString(longLike)).toBe('456');
  });

  it('a_long_like_value_without_toNumber_falls_back_to_low', () => {
    const longLike = { low: 789, high: 0 };
    expect(timestampToString(longLike)).toBe('789');
  });

  it('a_long_like_value_with_nonzero_high_and_no_toNumber_still_only_uses_low', () => {
    // Documents actual (lossy) behaviour: a Long-like without toNumber()
    // loses the high bits entirely - this is the current implementation,
    // not a recommendation.
    const longLike = { low: 100, high: 5 };
    expect(timestampToString(longLike)).toBe('100');
  });
});

describe('receiptsFromReceiptUpdate edge cases', () => {
  it('readTimestamp_zero_is_a_present_falsy_timestamp_not_treated_as_absent', () => {
    // readTimestamp: 0 - timestampToString(0) returns '0' (a string, not
    // null), so readTs !== null and this IS treated as a read receipt with
    // eventTs '0', never falling through to played/delivered.
    const payload = [
      {
        key: { fromMe: true, id: 'MSG-ZERO', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', readTimestamp: 0, receiptTimestamp: 500 },
      },
    ];
    expect(receiptsFromReceiptUpdate(payload)).toEqual([
      {
        waMsgId: 'MSG-ZERO',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'read',
        eventTs: '0',
        participantJid: '',
      },
    ]);
  });

  it('a_null_readTimestamp_is_absent_and_falls_through_to_delivered', () => {
    const payload = [
      {
        key: { fromMe: true, id: 'MSG-NULL-READ', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', readTimestamp: null, receiptTimestamp: 500 },
      },
    ];
    expect(receiptsFromReceiptUpdate(payload)).toEqual([
      {
        waMsgId: 'MSG-NULL-READ',
        remoteJid: 'a@s.whatsapp.net',
        eventType: 'delivered',
        eventTs: '500',
        participantJid: '',
      },
    ]);
  });

  it('a_group_remote_jid_with_an_undefined_userJid_yields_empty_string_participant_not_the_literal_undefined', () => {
    const payload = [
      {
        key: { fromMe: true, id: 'MSG-NO-USER', remoteJid: 'group@g.us' },
        receipt: { receiptTimestamp: 100 },
      },
    ];
    const result = receiptsFromReceiptUpdate(payload);
    expect(result).toHaveLength(1);
    expect(result[0]?.participantJid).toBe('');
    expect(result[0]?.participantJid).not.toBe('undefined');
  });

  it('replaying_the_same_read_receipt_with_a_different_receiptTimestamp_but_the_same_readTimestamp_dedupes_as_one_read', () => {
    // The id is built from (waMsgId, eventType, eventTs, participantJid) -
    // receiptTimestamp/deliveredTs is never consulted once readTs wins, so
    // two payloads differing ONLY in receiptTimestamp produce the identical
    // parsed InboundReceipt (same eventTs = the read timestamp) and
    // therefore the identical provider_event_id on replay.
    const first = receiptsFromReceiptUpdate([
      {
        key: { fromMe: true, id: 'MSG-REPLAY', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', readTimestamp: 9000, receiptTimestamp: 1000 },
      },
    ]);
    const second = receiptsFromReceiptUpdate([
      {
        key: { fromMe: true, id: 'MSG-REPLAY', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', readTimestamp: 9000, receiptTimestamp: 5000 },
      },
    ]);
    expect(first).toEqual(second);
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
        // A real driver always returns rowCount; the receipt in these tests
        // is never for a campaign job, so this matches zero rows.
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

describe('the messages.update vs message-receipt.update double-row question (documented, unit-level)', () => {
  it('a_delivered_messages_update_then_a_delivered_message_receipt_update_for_the_same_dm_dedupe_to_one_row', async () => {
    // FIXED (see receipts.ts#recordInboundReceipt's own doc comment): the
    // idempotency identity of a receipt is (instance_id, wa_msg_id,
    // event_type, participant_jid) - the provider timestamp is deliberately
    // EXCLUDED from the hash input. A `messages.update` delivered receipt
    // always carries eventTs='' (no provider timestamp on that event
    // shape); a `message-receipt.update` delivered receipt for the SAME
    // wa_msg_id carries a real eventTs - both are ONE logical 'delivered'
    // for this DM and must collapse to ONE delivery_events row.
    const matchedRow = { message_id: '42', message_created_at_text: '2026-01-01 00:00:00+00' };
    const registry = createMetricsRegistry();
    const metrics = bindInboundMetrics(registry);

    const fromMessagesUpdate = receiptsFromMessagesUpdate([
      {
        key: { fromMe: true, id: 'MSG-DOUBLE', remoteJid: 'a@s.whatsapp.net' },
        update: { status: 3 },
      },
    ])[0]!;
    const fromReceiptUpdate = receiptsFromReceiptUpdate([
      {
        key: { fromMe: true, id: 'MSG-DOUBLE', remoteJid: 'a@s.whatsapp.net' },
        receipt: { userJid: 'a@s.whatsapp.net', receiptTimestamp: 1700000000 },
      },
    ])[0]!;

    // The parsed InboundReceipt objects still carry DIFFERENT eventTs
    // (informational, kept for P23's timeline) - the identity fix lives at
    // the recordInboundReceipt call site, not in the parsers.
    expect(fromMessagesUpdate.eventTs).toBe('');
    expect(fromReceiptUpdate.eventTs).toBe('1700000000');

    const { tenantDb: db1 } = makeFakeTenantDb({ matchedRow, dedupeRowCount: 1 });
    const outcome1 = await recordInboundReceipt(
      { tenantDb: db1, clientId: 'client-1', instanceId: 'instance-1', metrics },
      fromMessagesUpdate,
    );
    const { tenantDb: db2 } = makeFakeTenantDb({ matchedRow, dedupeRowCount: 0 });
    const outcome2 = await recordInboundReceipt(
      { tenantDb: db2, clientId: 'client-1', instanceId: 'instance-1', metrics },
      fromReceiptUpdate,
    );

    expect(outcome1).toBe('recorded');
    expect(outcome2).toBe('duplicate');
    expect(
      (await metrics.receiptsTotal.get()).values.find((v) => v.labels.event_type === 'delivered')
        ?.value,
    ).toBe(1);
  });
});
