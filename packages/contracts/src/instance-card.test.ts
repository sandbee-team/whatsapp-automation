import { describe, expect, it } from 'vitest';
import { instanceCardOutputSchema, healthWhyOutputSchema } from './instance-card.js';

/**
 * instance-card.test.ts (P17 Unit U2) - schema-level proof that the card
 * output accepts the full documented shape (including nullable fields) and
 * that the health/why output's signals array is exactly twelve entries with
 * the required per-signal shape.
 */

const VALID_CARD = {
  data: {
    instanceId: '11111111-1111-4111-8111-111111111111',
    label: 'Sales line',
    linkState: 'linked',
    healthState: 'connected',
    desiredState: 'online',
    parked: false,
    needsUserAction: false,
    userActionReason: null,
    healthScore: 92,
    healthBand: 'HEALTHY',
    warmupTier: 3,
    warmupDay: 4,
    todaySent: 120,
    effDailyCap: 500,
    newConversationsToday: 5,
    effNewConvCap: 20,
    sendingWindow: { start: '09:00', end: '20:00', tz: 'Asia/Kolkata' },
    lastSendAt: '2026-09-03T05:00:00.000Z',
    queueDepth: 12,
    queueDepthCapped: false,
    oldestQueuedAgeSeconds: 30,
    nextSendEarliestAt: '2026-09-03T05:01:00.000Z',
    serverNow: '2026-09-03T05:00:30.000Z',
  },
  meta: { requestId: 'req-1' },
};

describe('instanceCardOutputSchema', () => {
  it('accepts_the_full_documented_shape', () => {
    const result = instanceCardOutputSchema.safeParse(VALID_CARD);
    expect(result.success).toBe(true);
  });

  it('accepts_null_for_the_nullable_fields', () => {
    const result = instanceCardOutputSchema.safeParse({
      data: {
        ...VALID_CARD.data,
        userActionReason: null,
        healthScore: null,
        lastSendAt: null,
        oldestQueuedAgeSeconds: null,
        nextSendEarliestAt: null,
      },
      meta: VALID_CARD.meta,
    });
    expect(result.success).toBe(true);
  });
});

describe('healthWhyOutputSchema', () => {
  it('accepts_exactly_twelve_signal_entries_plus_a_timeline', () => {
    const signal = {
      signal: 'hard_restriction',
      measuredValue: null,
      window: '24h',
      evidenceCount: 0,
      scored: true,
      pointsCost: 0,
      exemptReason: null,
    };
    const result = healthWhyOutputSchema.safeParse({
      data: {
        signals: Array.from({ length: 12 }, () => signal),
        timeline: [{ id: 'evt-1', kind: 'paused_hold', createdAt: '2026-09-03T05:00:00.000Z' }],
      },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects_a_signals_array_that_is_not_exactly_twelve', () => {
    const signal = {
      signal: 'hard_restriction',
      measuredValue: null,
      window: '24h',
      evidenceCount: 0,
      scored: true,
      pointsCost: 0,
      exemptReason: null,
    };
    const result = healthWhyOutputSchema.safeParse({
      data: { signals: [signal], timeline: [] },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(false);
  });
});
