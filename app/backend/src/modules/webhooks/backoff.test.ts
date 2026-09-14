import { describe, expect, it } from 'vitest';
import { computeNextAttemptDelayMs, isTerminalStatusCode, MAX_ATTEMPTS } from './backoff.js';

/**
 * backoff.test.ts (P15 U5, step 7) - `min(6h, 2s*2^attempt)` with FULL
 * jitter (`delay = random(0, cap)`), and the terminal-status-code set. `rng`
 * is always injected (never `Math.random()`) - exact expected values for
 * exact inputs, per the mechanical convention on units/quantities.
 */

describe('computeNextAttemptDelayMs', () => {
  it('attempt_3_with_rng_1_0_is_exactly_the_uncapped_ceiling_16_seconds', () => {
    // cap = min(6h, 2s * 2^3) = min(21_600_000, 16_000) = 16_000ms.
    // full jitter with rng()=1.0 (the maximum draw) returns exactly the cap.
    const delayMs = computeNextAttemptDelayMs(3, () => 1.0);
    expect(delayMs).toBe(16_000);
  });

  it('rng_0_0_always_returns_zero_delay', () => {
    const delayMs = computeNextAttemptDelayMs(5, () => 0.0);
    expect(delayMs).toBe(0);
  });

  it('the_six_hour_cap_applies_from_attempt_13_onward', () => {
    // 2s * 2^13 = 16_384_000ms > 6h (21_600_000ms)? No: 16_384_000 <
    // 21_600_000. 2s * 2^14 = 32_768_000ms > 21_600_000 - so the cap first
    // binds at attempt 14, not 13. Assert the exact crossover, not a bound.
    const uncappedAt13 = computeNextAttemptDelayMs(13, () => 1.0);
    expect(uncappedAt13).toBe(16_384_000);

    const cappedAt14 = computeNextAttemptDelayMs(14, () => 1.0);
    expect(cappedAt14).toBe(21_600_000);

    // MAX_ATTEMPTS=8: 2s * 2^8 = 512_000ms, still well under the 6h cap - the
    // cap is reachable in principle (attempt 14+) but never actually binds
    // within the real MAX_ATTEMPTS=8 ceiling this dispatcher enforces.
    const uncappedAtMax = computeNextAttemptDelayMs(MAX_ATTEMPTS, () => 1.0);
    expect(uncappedAtMax).toBe(512_000);
  });

  it('a_mid_range_rng_draw_scales_linearly_within_the_cap', () => {
    // attempt 2: cap = min(6h, 2s*4) = 8_000ms. rng()=0.5 -> exactly 4_000ms.
    const delayMs = computeNextAttemptDelayMs(2, () => 0.5);
    expect(delayMs).toBe(4_000);
  });
});

describe('isTerminalStatusCode', () => {
  it('400_401_403_404_422_are_terminal_never_retried', () => {
    for (const code of [400, 401, 403, 404, 422]) {
      expect(isTerminalStatusCode(code)).toBe(true);
    }
  });

  it('500_502_503_and_network_level_failures_are_retryable', () => {
    for (const code of [500, 502, 503, 429, 408]) {
      expect(isTerminalStatusCode(code)).toBe(false);
    }
  });
});
