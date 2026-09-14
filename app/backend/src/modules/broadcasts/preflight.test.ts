import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it } from 'vitest';
import { computeBillable, computeEstimate, computeQuoteMinor } from './preflight.service.js';

/**
 * preflight.test.ts (P23a Unit U1a, step 2) - pure unit proofs over the
 * pre-flight quote's three derivation functions: `computeEstimate`
 * (cap-derived finish estimate + the two fixed levers, never a "faster"
 * option), `computeQuoteMinor` (integer paise product), and
 * `computeBillable` (matched - skipped - client-level deferrals). No DB, no
 * clock - every input is injected.
 */

describe('preflight.service pure helpers (P23a Unit U1a)', () => {
  it('estimate_from_cap_is_250_days_for_5000_billable_at_20_per_day', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const estimate = computeEstimate({ billable: 5000, effDailyCap: 20, sentToday: 0, now });

    expect(estimate.totalDays).toBe(250);
    expect(estimate.options).toEqual(['reduce_audience', 'wait_for_warm_up']);
  });

  it('estimate_is_zero_days_when_nothing_is_billable', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const estimate = computeEstimate({ billable: 0, effDailyCap: 20, sentToday: 0, now });

    expect(estimate.totalDays).toBe(0);
    expect(estimate.finishAt).toBe(now.toISOString());
  });

  it('estimate_is_null_when_the_cap_is_zero', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const estimate = computeEstimate({ billable: 5000, effDailyCap: 0, sentToday: 0, now });

    expect(estimate.totalDays).toBeNull();
    expect(estimate.finishAt).toBeNull();
  });

  it('estimate_finishes_today_when_billable_fits_the_remaining_cap', () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const estimate = computeEstimate({ billable: 15, effDailyCap: 20, sentToday: 5, now });

    expect(estimate.totalDays).toBe(1);
    expect(estimate.finishAt).toBe(now.toISOString());
  });

  it('quote_is_the_integer_paise_product', () => {
    const quoteMinor = computeQuoteMinor(2003, 15);

    expect(quoteMinor).toBe(30045);
    expect(Number.isInteger(quoteMinor)).toBe(true);
  });

  it('billable_excludes_skipped_and_client_level_deferrals', () => {
    const result = computeBillable({
      matched: 2140,
      skipReasons: [
        { reason: 'opted_out', count: 37 },
        { reason: 'missing_var:city', count: 12 },
      ],
      deferred: 88,
    });

    expect(result.skipped).toBe(49);
    expect(result.sendable).toBe(2091);
    expect(result.billable).toBe(2003);
  });

  // P23a C1 fix round unit F2 (MINOR 5) - `matched` is derived from the SAME
  // audience walk `computeBillable` already reduces over (never a separate
  // `countAudience` snapshot that can disagree with it under a concurrent
  // write), so `sendable` can never go negative and the identity
  // `matched === sendable + skipped` always holds by construction.
  it('sendable_never_goes_negative_when_matched_equals_sendable_plus_skipped_by_construction', () => {
    const skipReasons = [
      { reason: 'opted_out', count: 3 },
      { reason: 'missing_var:city', count: 2 },
    ];
    const skipped = skipReasons.reduce((sum, r) => sum + r.count, 0);
    const sendableFromWalk = 4;
    const matched = sendableFromWalk + skipped;

    const result = computeBillable({ matched, skipReasons, deferred: 1 });

    expect(result.skipped).toBe(5);
    expect(result.sendable).toBe(4);
    expect(matched).toBe(result.sendable + result.skipped);
    expect(result.sendable).toBeGreaterThanOrEqual(0);
    expect(result.billable).toBe(3);
  });
});
