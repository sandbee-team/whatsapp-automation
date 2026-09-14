import { describe, expect, it } from 'vitest';
import { decideEvalTier, EVAL_TIER_DELAYS_MS } from './eval-tier-ladder.js';

/**
 * eval-tier-ladder.test.ts (P16 Unit E, step 9) - pure decision table for the
 * health evaluator's due-scan cadence, replacing HealthEvaluator.ts's P16
 * Unit C placeholder (`nextEvalDueAt`, a flat 5-minute delay). No DB access,
 * no `Date.now()` - every timestamp is a caller-supplied epoch-millis number
 * (same discipline as `bands.ts`).
 *
 * Tier ladder (task-normative): tier 1 = 60s (instance sent/failed/
 * disconnected in the last 15 min, OR band changed in the last hour); tier 2
 * = 5 min (connected, idle); tier 3 = 30 min (paused, parked, logged out).
 */

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('decideEvalTier', () => {
  it('is_tier_one_when_a_send_outcome_happened_in_the_last_fifteen_minutes', () => {
    const nowMs = 1_000_000_000;
    const result = decideEvalTier({
      nowMs,
      healthState: 'connected',
      bandChanged: false,
      bandChangedAtMs: null,
      lastSendOutcomeAtMs: nowMs - FIFTEEN_MIN_MS + 1,
    });
    expect(result.tier).toBe(1);
    expect(result.nextEvalDueAtMs).toBe(nowMs + EVAL_TIER_DELAYS_MS[1]);
  });

  it('is_tier_one_when_the_band_changed_on_this_tick', () => {
    const nowMs = 2_000_000_000;
    const result = decideEvalTier({
      nowMs,
      healthState: 'connected',
      bandChanged: true,
      bandChangedAtMs: null,
      lastSendOutcomeAtMs: null,
    });
    expect(result.tier).toBe(1);
  });

  it('is_tier_one_when_the_band_changed_within_the_last_hour_even_off_tick', () => {
    const nowMs = 3_000_000_000;
    const result = decideEvalTier({
      nowMs,
      healthState: 'connected',
      bandChanged: false,
      bandChangedAtMs: nowMs - ONE_HOUR_MS + 1,
      lastSendOutcomeAtMs: null,
    });
    expect(result.tier).toBe(1);
  });

  it('is_tier_two_when_connected_idle_with_no_recent_activity', () => {
    const nowMs = 4_000_000_000;
    const result = decideEvalTier({
      nowMs,
      healthState: 'connected',
      bandChanged: false,
      bandChangedAtMs: nowMs - ONE_HOUR_MS - 1,
      lastSendOutcomeAtMs: nowMs - FIFTEEN_MIN_MS - 1,
    });
    expect(result.tier).toBe(2);
    expect(result.nextEvalDueAtMs).toBe(nowMs + EVAL_TIER_DELAYS_MS[2]);
  });

  it.each(['paused', 'parked', 'logged_out'])(
    'is_tier_three_when_health_state_is_%s',
    (healthState) => {
      const nowMs = 5_000_000_000;
      const result = decideEvalTier({
        nowMs,
        healthState,
        bandChanged: false,
        bandChangedAtMs: null,
        lastSendOutcomeAtMs: null,
      });
      expect(result.tier).toBe(3);
      expect(result.nextEvalDueAtMs).toBe(nowMs + EVAL_TIER_DELAYS_MS[3]);
    },
  );

  it('paused_state_wins_over_a_recent_send_outcome', () => {
    const nowMs = 6_000_000_000;
    const result = decideEvalTier({
      nowMs,
      healthState: 'paused',
      bandChanged: false,
      bandChangedAtMs: null,
      lastSendOutcomeAtMs: nowMs - 1,
    });
    expect(result.tier).toBe(3);
  });
});
