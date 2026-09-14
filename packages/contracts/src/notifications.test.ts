import { describe, expect, it } from 'vitest';
import {
  listNotificationsInputSchema,
  listNotificationsItemSchema,
  markReadOutputSchema,
} from './notifications.js';

/**
 * notifications.test.ts (P17 Unit U2) - schema-level edge cases for the
 * notifications list route: default/clamped `limit`, `.strict()` rejects an
 * unknown field, and the list item shape accepts a null `instanceId`/`readAt`
 * (unread rows / instance-less rows).
 */
describe('listNotificationsInputSchema', () => {
  it('defaults_limit_to_25_when_omitted', () => {
    const result = listNotificationsInputSchema.parse({});
    expect(result.limit).toBe(25);
  });

  it('rejects_a_limit_above_100', () => {
    const result = listNotificationsInputSchema.safeParse({ limit: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects_a_limit_below_1', () => {
    const result = listNotificationsInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it('strict_mode_rejects_an_unknown_extra_field', () => {
    const result = listNotificationsInputSchema.safeParse({ extra: 'smuggled' });
    expect(result.success).toBe(false);
  });

  it('accepts_an_optional_cursor_and_unread_filter', () => {
    // `unread` is a query-string field: Fastify hands it over as the
    // literal string 'true'/'false', never a real boolean (P26b finding c,
    // carried in P28 Unit U2) - see `list-query-coercion.test.ts`.
    const result = listNotificationsInputSchema.safeParse({
      cursor: 'opaque-cursor',
      unread: 'true',
      limit: 10,
    });
    expect(result.success).toBe(true);
  });
});

describe('listNotificationsItemSchema', () => {
  it('accepts_a_null_instanceId_and_null_readAt', () => {
    const result = listNotificationsItemSchema.safeParse({
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'plan_cap_reached',
      severity: 'warning',
      instanceId: null,
      title: 'Plan cap reached',
      requiresUserAction: false,
      createdAt: '2026-09-03T00:00:00.000Z',
      readAt: null,
      payload: {},
    });
    expect(result.success).toBe(true);
  });
});

describe('markReadOutputSchema', () => {
  it('accepts_a_read_confirmation_shape', () => {
    const result = markReadOutputSchema.safeParse({
      data: { id: '11111111-1111-4111-8111-111111111111', readAt: '2026-09-03T00:00:00.000Z' },
      meta: { requestId: 'req-1' },
    });
    expect(result.success).toBe(true);
  });
});
