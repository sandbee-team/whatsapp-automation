import { describe, expect, it } from 'vitest';
import { deliveryEventIdInput, providerEventIdInput } from './delivery-event-id.js';

describe('deliveryEventIdInput', () => {
  it('is_deterministic_for_the_same_four_inputs', () => {
    const a = deliveryEventIdInput('instance-1', 'public-1', 'sent', 0);
    const b = deliveryEventIdInput('instance-1', 'public-1', 'sent', 0);

    expect(a).toBe(b);
  });

  it('differs_when_any_single_input_differs', () => {
    const base = deliveryEventIdInput('instance-1', 'public-1', 'sent', 0);

    expect(deliveryEventIdInput('instance-2', 'public-1', 'sent', 0)).not.toBe(base);
    expect(deliveryEventIdInput('instance-1', 'public-2', 'sent', 0)).not.toBe(base);
    expect(deliveryEventIdInput('instance-1', 'public-1', 'delivered', 0)).not.toBe(base);
    expect(deliveryEventIdInput('instance-1', 'public-1', 'sent', 1)).not.toBe(base);
  });

  it('is_not_ambiguous_across_a_field_boundary_shift', () => {
    // Naive concatenation ("instance-1" + "public-1" + ... ) would collide
    // with ("instance-1public" + "-1" + ...) style boundary shifts unless a
    // separator that cannot appear inside the field values is used - here
    // instanceId/publicId are UUID-shaped (no colon), eventType is a fixed
    // enum label, and attemptNo is numeric, so a `:` separator is safe and
    // this asserts two different-looking boundary splits do not collide.
    const left = deliveryEventIdInput('a', 'bc', 'sent', 1);
    const right = deliveryEventIdInput('ab', 'c', 'sent', 1);

    expect(left).not.toBe(right);
  });

  it('exact_canonical_string_for_a_known_input', () => {
    expect(deliveryEventIdInput('inst-abc', 'pub-123', 'queued', 2)).toBe(
      'inst-abc:pub-123:queued:2',
    );
  });
});

describe('providerEventIdInput', () => {
  it('provider_event_id_input_is_deterministic_and_participant_aware', () => {
    const a = providerEventIdInput('instance-1', 'wa-msg-1', 'delivered', '1700000000', 'p-1');
    const b = providerEventIdInput('instance-1', 'wa-msg-1', 'delivered', '1700000000', 'p-1');
    expect(a).toBe(b);

    const differentParticipant = providerEventIdInput(
      'instance-1',
      'wa-msg-1',
      'delivered',
      '1700000000',
      'p-2',
    );
    expect(differentParticipant).not.toBe(a);

    const defaultParticipant = providerEventIdInput(
      'instance-1',
      'wa-msg-1',
      'delivered',
      '1700000000',
    );
    const explicitEmptyParticipant = providerEventIdInput(
      'instance-1',
      'wa-msg-1',
      'delivered',
      '1700000000',
      '',
    );
    expect(defaultParticipant).toBe(explicitEmptyParticipant);

    // A participant JID can contain ':' (device JIDs like "123:4@s.whatsapp.net")
    // - the unit separator must prevent an ambiguous field-boundary shift
    // between (waMsgId="m", participant="123:4@s.whatsapp.net") and
    // (waMsgId="m<sep>123", participant="4@s.whatsapp.net")-shaped inputs.
    const left = providerEventIdInput('instance-1', 'm', 'delivered', 'ts', '123:4@s.whatsapp.net');
    const right = providerEventIdInput('instance-1', `m123`, 'delivered', 'ts', '4@s.whatsapp.net');
    expect(left).not.toBe(right);
  });

  it('receipt_ids_never_collide_with_send_side_ids', () => {
    const receiptId = providerEventIdInput('instance-1', 'wa-msg-1', 'delivered', '', '');
    const sendId = deliveryEventIdInput('instance-1', 'wa-msg-1', 'delivered', 0);

    expect(receiptId).not.toBe(sendId);
  });

  it('empty_instance_or_message_id_is_rejected', () => {
    expect(() => providerEventIdInput('', 'wa-msg-1', 'delivered', 'ts')).toThrow(RangeError);
    expect(() => providerEventIdInput('instance-1', '', 'delivered', 'ts')).toThrow(RangeError);
    expect(() => providerEventIdInput('instance-1', 'wa-msg-1', '' as never, 'ts')).toThrow(
      RangeError,
    );
  });
});
