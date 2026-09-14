import { describe, expect, it } from 'vitest';
import { realtimeEventSchema, REALTIME_EVENT_TYPES } from '../src/index.js';

/**
 * tests/realtime-events.test.ts (P05 Unit U3a) - proves the blueprint's
 * real-time event table is exactly six events, every payload is
 * `.strict()` (ids/enums only, per the Observability rule: no phone number,
 * JID, message body, contact name, group subject), and the discriminated
 * union rejects anything outside that table.
 */

const VALID_SAMPLES: Record<string, Record<string, unknown>> = {
  'instance.qr': {
    type: 'instance.qr',
    instanceId: '11111111-1111-4111-8111-111111111111',
    expiresAt: '2026-08-27T12:00:00.000Z',
    attemptsLeft: 3,
    payload: 'fake-qr-payload',
  },
  'instance.health_changed': {
    type: 'instance.health_changed',
    instanceId: '11111111-1111-4111-8111-111111111111',
    healthState: 'connected',
    pauseReason: null,
    needsUserAction: false,
  },
  'instance.pacing_changed': {
    type: 'instance.pacing_changed',
    instanceId: '11111111-1111-4111-8111-111111111111',
    band: 'HIGH',
    tier: 1,
    effDailyCap: 500,
    configVersion: 2,
  },
  'message.job.status_changed': {
    type: 'message.job.status_changed',
    jobPublicId: 'job_abc123',
    instanceId: '11111111-1111-4111-8111-111111111111',
    status: 'sent',
  },
  'job.needs_user_action': {
    type: 'job.needs_user_action',
    jobPublicId: 'job_abc123',
    reason: 'unresolved_send',
  },
  'campaign.progress': {
    type: 'campaign.progress',
    campaignId: '11111111-1111-4111-8111-111111111111',
    sent: 10,
    queued: 5,
    failed: 1,
  },
  'webhook.endpoint_disabled': {
    type: 'webhook.endpoint_disabled',
    endpointId: '11111111-1111-4111-8111-111111111111',
  },
  'notification.created': {
    type: 'notification.created',
    notificationId: '11111111-1111-4111-8111-111111111111',
    kind: 'instance_paused',
    severity: 'critical',
    instanceId: '11111111-1111-4111-8111-111111111111',
  },
};

const FORBIDDEN_EXTRA_FIELDS: Record<string, unknown> = {
  phone: '+919876543210',
  jid: '919876543210@s.whatsapp.net',
  body: 'hello there',
  name: 'Some Contact Name',
};

describe('realtimeEventSchema', () => {
  it('every_event_in_the_blueprint_table_has_a_schema', () => {
    // 6 blueprint events + `webhook.endpoint_disabled` (P15 U5, step 7) +
    // `notification.created` (P17 Unit U2, step 2).
    expect(REALTIME_EVENT_TYPES).toHaveLength(8);

    for (const [type, sample] of Object.entries(VALID_SAMPLES)) {
      const result = realtimeEventSchema.safeParse(sample);
      expect(
        result.success,
        `expected ${type} sample to parse: ${JSON.stringify(result.success ? null : result.error)}`,
      ).toBe(true);
    }

    expect(realtimeEventSchema.safeParse({ type: 'made.up' }).success).toBe(false);
  });

  it('notification_created_accepts_an_omitted_optional_instanceId', () => {
    // instanceId is optional (not every kind is instance-scoped, e.g.
    // plan_cap_reached at the client level).
    const sample = VALID_SAMPLES['notification.created'] as Record<string, unknown>;
    const withoutInstanceId = Object.fromEntries(
      Object.entries(sample).filter(([key]) => key !== 'instanceId'),
    );
    expect(realtimeEventSchema.safeParse(withoutInstanceId).success).toBe(true);
  });

  it('an_event_payload_with_a_phone_number_field_is_rejected', () => {
    for (const [type, sample] of Object.entries(VALID_SAMPLES)) {
      // Sanity: the plain valid sample must parse on its own first.
      expect(realtimeEventSchema.safeParse(sample).success, `valid sample for ${type}`).toBe(true);

      for (const [extraKey, extraValue] of Object.entries(FORBIDDEN_EXTRA_FIELDS)) {
        const tainted = { ...sample, [extraKey]: extraValue };
        const result = realtimeEventSchema.safeParse(tainted);
        expect(
          result.success,
          `expected ${type} + extra key "${extraKey}" to be rejected (strict schema)`,
        ).toBe(false);
      }
    }
  });
});
