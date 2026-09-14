import { describe, expect, it } from 'vitest';
import { shouldTouchLastUsedAt, wasRevoked } from './repo.js';

/**
 * repo.test.ts (go-live U4) - pure-logic unit tests for `repo.ts`'s two
 * predicates that do NOT need a real Postgres connection:
 *   - `shouldTouchLastUsedAt` - the same 60-second throttle window the SQL
 *     `touchLastUsedAt` statement enforces in the database (`AND
 *     (last_used_at IS NULL OR last_used_at < now() - interval '60
 *     seconds')`), exposed as a plain function so the boundary itself is
 *     unit-testable without a live connection.
 *   - `wasRevoked` - maps a conditional UPDATE's `rowCount` to a boolean
 *     ("a row was actually revoked just now"), the same "conditional UPDATE
 *     -> rowCount -> boolean" shape `deleteWebhookEndpoint` already
 *     establishes (`modules/webhooks/service.ts`).
 *
 * The real `touchLastUsedAt`/`revokeApiKey` SQL statements are exercised by
 * `routes.integration.test.ts` against real Postgres - this file only proves
 * the boundary math these two predicates encode.
 */

describe('shouldTouchLastUsedAt', () => {
  it('is_true_when_last_used_at_is_null', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    expect(shouldTouchLastUsedAt(null, now)).toBe(true);
  });

  it('is_false_exactly_at_the_60_second_boundary', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    const lastUsedAt = new Date('2026-09-14T11:59:00.000Z'); // exactly 60s ago
    expect(shouldTouchLastUsedAt(lastUsedAt, now)).toBe(false);
  });

  it('is_true_just_past_the_60_second_boundary', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    const lastUsedAt = new Date('2026-09-14T11:58:59.999Z'); // 60.001s ago
    expect(shouldTouchLastUsedAt(lastUsedAt, now)).toBe(true);
  });

  it('is_false_well_within_the_60_second_window', () => {
    const now = new Date('2026-09-14T12:00:00.000Z');
    const lastUsedAt = new Date('2026-09-14T11:59:30.000Z'); // 30s ago
    expect(shouldTouchLastUsedAt(lastUsedAt, now)).toBe(false);
  });
});

describe('wasRevoked', () => {
  it('is_true_for_a_single_row_updated', () => {
    expect(wasRevoked(1)).toBe(true);
  });

  it('is_false_for_zero_rows_updated', () => {
    expect(wasRevoked(0)).toBe(false);
  });

  it('is_false_for_a_null_rowCount', () => {
    expect(wasRevoked(null)).toBe(false);
  });
});
