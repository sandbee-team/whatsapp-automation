import { describe, expect, it } from 'vitest';
import { paginationInputSchema } from './envelope.js';
import { listNotificationsInputSchema } from './notifications.js';
import { listBroadcastsQuerySchema } from './app/broadcasts.js';
import { listTopupsQuerySchema } from './internal/index.js';

/**
 * list-query-coercion.test.ts (P28 Unit U2, step 3; carried P26b finding c)
 * - Fastify hands every `req.query` value as a STRING, so any list query
 * schema built with a plain `z.number()` `limit` field rejects every real
 * request. Proves each list query schema parses `{ limit: '25' }` to the
 * number `25`, rejects `{ limit: 'abc' }`, and (for notifications) parses
 * `unread: 'false'` to the boolean `false` (never `true` -
 * `z.coerce.boolean()` would have coerced any non-empty string, including
 * the literal string `'false'`, to `true`).
 */

describe('paginationInputSchema (shared)', () => {
  it('parses_a_string_limit_to_a_number', () => {
    const result = paginationInputSchema.parse({ limit: '25' });
    expect(result.limit).toBe(25);
  });

  it('rejects_a_non_numeric_limit', () => {
    expect(() => paginationInputSchema.parse({ limit: 'abc' })).toThrow();
  });
});

describe('listNotificationsInputSchema', () => {
  it('parses_a_string_limit_to_a_number', () => {
    const result = listNotificationsInputSchema.parse({ limit: '25' });
    expect(result.limit).toBe(25);
  });

  it('rejects_a_non_numeric_limit', () => {
    expect(() => listNotificationsInputSchema.parse({ limit: 'abc' })).toThrow();
  });

  it('parses_unread_false_string_to_the_boolean_false', () => {
    const result = listNotificationsInputSchema.parse({ unread: 'false' });
    expect(result.unread).toBe(false);
  });

  it('parses_unread_true_string_to_the_boolean_true', () => {
    const result = listNotificationsInputSchema.parse({ unread: 'true' });
    expect(result.unread).toBe(true);
  });
});

describe('listBroadcastsQuerySchema', () => {
  it('parses_a_string_limit_to_a_number', () => {
    const result = listBroadcastsQuerySchema.parse({ limit: '25' });
    expect(result.limit).toBe(25);
  });

  it('rejects_a_non_numeric_limit', () => {
    expect(() => listBroadcastsQuerySchema.parse({ limit: 'abc' })).toThrow();
  });
});

describe('listTopupsQuerySchema', () => {
  it('parses_a_string_limit_to_a_number', () => {
    const result = listTopupsQuerySchema.parse({ limit: '25', status: 'pending' });
    expect(result.limit).toBe(25);
  });

  it('rejects_a_non_numeric_limit', () => {
    expect(() => listTopupsQuerySchema.parse({ limit: 'abc', status: 'pending' })).toThrow();
  });
});
