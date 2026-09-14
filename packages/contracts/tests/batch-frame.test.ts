import { describe, expect, it } from 'vitest';
import { batchFrameSchema } from '../src/index.js';

/**
 * tests/batch-frame.test.ts (P15 U2, step 3) - proves the outbox relay's
 * `batch` frame shape: `.strict()`, ids/enums-only member events (same
 * `realtimeEventSchema` union as the single-event frame), and the ≤25 cap
 * (P15 dispatch plan: "> 25 keys -> truncated:true and the client
 * refetches").
 */

function healthChangedEvent(instanceId: string) {
  return {
    type: 'instance.health_changed' as const,
    instanceId,
    healthState: 'connected' as const,
    pauseReason: null,
    needsUserAction: false,
  };
}

describe('batchFrameSchema', () => {
  it('accepts_a_valid_batch_of_up_to_25_events', () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      healthChangedEvent(`11111111-1111-4111-8111-11111111111${(i % 10).toString()}`),
    );

    const result = batchFrameSchema.safeParse({ v: 1, events, truncated: false });

    expect(result.success).toBe(true);
  });

  it('rejects_a_batch_with_more_than_25_events', () => {
    const events = Array.from({ length: 26 }, () =>
      healthChangedEvent('11111111-1111-4111-8111-111111111111'),
    );

    const result = batchFrameSchema.safeParse({ v: 1, events, truncated: true });

    expect(result.success).toBe(false);
  });

  it('is_strict_and_rejects_an_unknown_top_level_key', () => {
    const result = batchFrameSchema.safeParse({
      v: 1,
      events: [healthChangedEvent('11111111-1111-4111-8111-111111111111')],
      truncated: false,
      extra: 'nope',
    });

    expect(result.success).toBe(false);
  });

  it('rejects_a_member_event_carrying_a_planted_phone_field', () => {
    const tainted = {
      ...healthChangedEvent('11111111-1111-4111-8111-111111111111'),
      phone: '+919876543210',
    };

    const result = batchFrameSchema.safeParse({ v: 1, events: [tainted], truncated: false });

    expect(result.success).toBe(false);
  });

  it('rejects_a_member_event_carrying_a_planted_body_field', () => {
    const tainted = {
      ...healthChangedEvent('11111111-1111-4111-8111-111111111111'),
      body: 'hello there',
    };

    const result = batchFrameSchema.safeParse({ v: 1, events: [tainted], truncated: false });

    expect(result.success).toBe(false);
  });

  it('rejects_a_wrong_version_literal', () => {
    const result = batchFrameSchema.safeParse({
      v: 2,
      events: [healthChangedEvent('11111111-1111-4111-8111-111111111111')],
      truncated: false,
    });

    expect(result.success).toBe(false);
  });
});
