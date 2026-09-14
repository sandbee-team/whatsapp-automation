import { describe, expect, it } from 'vitest';
import {
  createWebhookEndpointInputSchema,
  patchWebhookEndpointInputSchema,
  WEBHOOK_EVENT_TYPES,
} from '../src/index.js';

/**
 * tests/webhooks.test.ts (P15 U2, step 3) - proves `events` on create/patch
 * is validated against `WEBHOOK_EVENT_TYPES` (REALTIME_EVENT_TYPES minus
 * `instance.qr` - a QR never enters the outbox and is never
 * webhook-subscribable), and both input schemas stay `.strict()`.
 */

describe('WEBHOOK_EVENT_TYPES', () => {
  it('excludes_instance_qr_and_nothing_else_from_the_realtime_event_union', () => {
    expect(WEBHOOK_EVENT_TYPES).not.toContain('instance.qr');
    expect(WEBHOOK_EVENT_TYPES).toEqual([
      'instance.health_changed',
      'instance.pacing_changed',
      'message.job.status_changed',
      'job.needs_user_action',
      'campaign.progress',
      'notification.created',
    ]);
  });
});

describe('createWebhookEndpointInputSchema', () => {
  const validInput = {
    url: 'https://tenant.example.com/hooks/wp',
    events: ['instance.health_changed', 'job.needs_user_action'],
  };

  it('accepts_a_valid_https_url_and_known_event_names', () => {
    expect(createWebhookEndpointInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects_an_http_url_in_production_shape', () => {
    const result = createWebhookEndpointInputSchema.safeParse({
      ...validInput,
      url: 'http://tenant.example.com/hooks/wp',
    });
    expect(result.success).toBe(false);
  });

  it('rejects_an_unknown_event_name', () => {
    const result = createWebhookEndpointInputSchema.safeParse({
      ...validInput,
      events: ['made.up.event'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects_instance_qr_as_a_subscribable_event', () => {
    const result = createWebhookEndpointInputSchema.safeParse({
      ...validInput,
      events: ['instance.qr'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects_an_empty_events_array', () => {
    const result = createWebhookEndpointInputSchema.safeParse({ ...validInput, events: [] });
    expect(result.success).toBe(false);
  });

  it('is_strict_and_rejects_an_unknown_top_level_key', () => {
    const result = createWebhookEndpointInputSchema.safeParse({ ...validInput, secret: 'hax' });
    expect(result.success).toBe(false);
  });
});

describe('patchWebhookEndpointInputSchema', () => {
  it('accepts_a_partial_patch_with_just_enabled', () => {
    const result = patchWebhookEndpointInputSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects_an_unknown_event_name_in_a_patch', () => {
    const result = patchWebhookEndpointInputSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      events: ['not.a.real.event'],
    });
    expect(result.success).toBe(false);
  });
});
