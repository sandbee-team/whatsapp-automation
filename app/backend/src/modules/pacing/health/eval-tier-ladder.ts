/**
 * eval-tier-ladder.ts (P16 Unit E, step 9) - pure decision table for the
 * health evaluator's due-scan cadence, replacing `HealthEvaluator.ts`'s P16
 * Unit C placeholder (`nextEvalDueAt`, a flat 5-minute delay - see that
 * module's own doc comment for the exact hand-off). NO DB access, NO
 * `Date.now()` - every timestamp is a caller-supplied epoch-millis number,
 * same discipline as `bands.ts`.
 *
 * Tier ladder (task-normative, checked most-urgent-first):
 *   tier 1 = due every 60s  - the instance sent/failed/disconnected in the
 *            last 15 minutes, OR its band changed in the last hour.
 *   tier 2 = due every 5 min - connected, idle (the default/fallback tier).
 *   tier 3 = due every 30 min - paused, parked, or logged out (no send
 *            activity is possible, so frequent re-evaluation buys nothing).
 *
 * `paused`/`parked`/`logged_out` (tier 3) wins over a recent send outcome or
 * band change - once an instance can no longer send, tier 1's activity
 * signals are stale by construction (`fast-lane.ts`'s own hard-signal-pause
 * path already forces an immediate evaluation on the transition itself; this
 * ladder only governs the ONGOING cadence afterward).
 */

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const EVAL_TIER_DELAYS_MS: Readonly<Record<1 | 2 | 3, number>> = Object.freeze({
  1: 60 * 1000,
  2: 5 * 60 * 1000,
  3: 30 * 60 * 1000,
});

const TIER_THREE_HEALTH_STATES: ReadonlySet<string> = new Set(['paused', 'parked', 'logged_out']);

export interface DecideEvalTierInput {
  nowMs: number;
  healthState: string;
  /** True when THIS tick's `decideBand` call changed the band (an in-statement signal, cheaper than a lookback query). */
  bandChanged: boolean;
  /** The most recent BAND_CHANGE timestamp on record, if any - covers a band change from an EARLIER tick that is still within the 1h window. */
  bandChangedAtMs: number | null;
  /** The most recent send-outcome (sent/failed/disconnected) timestamp on record, if any. */
  lastSendOutcomeAtMs: number | null;
}

export interface DecideEvalTierResult {
  tier: 1 | 2 | 3;
  nextEvalDueAtMs: number;
}

export function decideEvalTier(input: DecideEvalTierInput): DecideEvalTierResult {
  const tier = resolveTier(input);
  return { tier, nextEvalDueAtMs: input.nowMs + EVAL_TIER_DELAYS_MS[tier] };
}

function resolveTier(input: DecideEvalTierInput): 1 | 2 | 3 {
  if (TIER_THREE_HEALTH_STATES.has(input.healthState)) {
    return 3;
  }

  const recentSend =
    input.lastSendOutcomeAtMs !== null && input.nowMs - input.lastSendOutcomeAtMs <= FIFTEEN_MIN_MS;
  const recentBandChange =
    input.bandChanged ||
    (input.bandChangedAtMs !== null && input.nowMs - input.bandChangedAtMs <= ONE_HOUR_MS);

  if (recentSend || recentBandChange) {
    return 1;
  }

  return 2;
}
