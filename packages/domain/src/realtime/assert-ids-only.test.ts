import { describe, expect, it } from 'vitest';
import { assertIdsOnly, REALTIME_PAYLOAD_KEYS } from './assert-ids-only.js';

/**
 * assert-ids-only.test.ts (P05 Unit U3a) - proves the Observability rule
 * ("event payloads ... carry ids and enums only") is enforced mechanically,
 * not just by convention: any key outside the allow-list, any phone/JID-
 * shaped string value, any over-long string, or any nested object/array
 * throws.
 */

describe('assertIdsOnly', () => {
  const allowed = ['instanceId', 'status', 'count'] as const;

  it('accepts_a_conforming_ids_and_enums_only_payload', () => {
    expect(() =>
      assertIdsOnly({ instanceId: 'abc-123', status: 'sent', count: 3 }, allowed),
    ).not.toThrow();
  });

  it('accepts_null_and_boolean_values', () => {
    expect(() =>
      assertIdsOnly({ instanceId: null, status: true }, ['instanceId', 'status']),
    ).not.toThrow();
  });

  it('assert_ids_only_rejects_phone_like_and_nested_values', () => {
    expect(() => assertIdsOnly({ instanceId: '+919876543210' }, ['instanceId'])).toThrow();
    expect(() =>
      assertIdsOnly({ instanceId: '919876543210@s.whatsapp.net' }, ['instanceId']),
    ).toThrow();
    expect(() => assertIdsOnly({ instanceId: 'has a space' }, ['instanceId'])).toThrow();
    expect(() => assertIdsOnly({ instanceId: 'x'.repeat(65) }, ['instanceId'])).toThrow();
    expect(() => assertIdsOnly({ instanceId: { nested: true } }, ['instanceId'])).toThrow();
    expect(() => assertIdsOnly({ instanceId: [1, 2, 3] }, ['instanceId'])).toThrow();
  });

  it('rejects_a_key_outside_the_allow_list', () => {
    expect(() => assertIdsOnly({ phone: '123' }, ['instanceId'])).toThrow();
  });

  it('instance_qr_payload_key_stays_exempt_from_the_shape_checks', () => {
    // The opaque QR/pairing-code bearer credential is long and can contain
    // whitespace/@/+ shapes - still exempt when keyed correctly.
    expect(() =>
      assertIdsOnly({ payload: 'x'.repeat(200) + ' @+not-an-id' }, ['payload'], 'instance.qr'),
    ).not.toThrow();
  });

  it('a_synthetic_other_type_payload_key_is_not_exempt', () => {
    // FIX BATCH B / B2: the exemption is keyed by `${eventType}:${key}`, not
    // by the bare key "payload" - a different event type that also happens
    // to declare a "payload" key must NOT silently inherit the exemption.
    expect(() =>
      assertIdsOnly({ payload: 'x'.repeat(200) + ' @+not-an-id' }, ['payload'], 'some.other.type'),
    ).toThrow();

    // Same failing shape with no eventType supplied at all.
    expect(() =>
      assertIdsOnly({ payload: 'x'.repeat(200) + ' @+not-an-id' }, ['payload']),
    ).toThrow();
  });

  it('notification_created_key_allow_list_is_exactly_the_documented_ids_and_enums_only_set', () => {
    // P17 Unit U2 - REALTIME_PAYLOAD_KEYS gains 'notification.created' -> its
    // exact key allow-list. instanceId is included even though the event
    // schema marks it optional (the allow-list only names which keys MAY
    // appear, not which are required).
    expect(REALTIME_PAYLOAD_KEYS['notification.created']).toEqual([
      'notificationId',
      'kind',
      'severity',
      'instanceId',
    ]);
    expect(() =>
      assertIdsOnly(
        { notificationId: 'abc-123', kind: 'instance_paused', severity: 'critical' },
        REALTIME_PAYLOAD_KEYS['notification.created'],
        'notification.created',
      ),
    ).not.toThrow();
  });
});
