import { describe, expect, it } from 'vitest';
import { providerEventIdInput } from './delivery-event-id.js';

/**
 * delivery-event-id-edge.test.ts (P21 E3 hardening) - additional
 * `providerEventIdInput` cases beyond the sibling `delivery-event-id.test.ts`:
 * an empty `eventTs` (the `messages.update` shape) still produces a stable
 * id distinct from a non-empty-`eventTs` receipt-update shape for the SAME
 * wa_msg_id/eventType, and a `readTimestamp` of the numeric string '0' is
 * distinct from the empty string (falsy-but-present is not "no timestamp").
 */
describe('providerEventIdInput edge cases', () => {
  it('empty_event_ts_and_a_zero_event_ts_string_produce_different_ids', () => {
    const emptyTs = providerEventIdInput('instance-1', 'MSG-1', 'delivered', '', '');
    const zeroTs = providerEventIdInput('instance-1', 'MSG-1', 'delivered', '0', '');
    expect(emptyTs).not.toBe(zeroTs);
  });

  it('replaying_the_same_five_inputs_is_fully_deterministic_across_many_calls', () => {
    const ids = Array.from({ length: 10 }, () =>
      providerEventIdInput('instance-1', 'MSG-REPLAY', 'read', '1700000000', 'p@s.whatsapp.net'),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('a_failed_event_type_id_is_distinct_from_delivered_and_read_for_the_same_message', () => {
    const delivered = providerEventIdInput('instance-1', 'MSG-1', 'delivered', '1000');
    const read = providerEventIdInput('instance-1', 'MSG-1', 'read', '1000');
    const failed = providerEventIdInput('instance-1', 'MSG-1', 'failed', '1000');
    expect(new Set([delivered, read, failed]).size).toBe(3);
  });
});
