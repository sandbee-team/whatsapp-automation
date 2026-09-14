import type { Rng } from '../ports.js';
import {
  ABSOLUTE_GAP_MIN_MS,
  LONG_PAUSE_CAP_MS,
  LONG_PAUSE_MAX_EVERY_N_SENDS,
  LONG_PAUSE_MIN_EVERY_N_SENDS,
  LONG_PAUSE_MULTIPLIER_MAX,
  LONG_PAUSE_MULTIPLIER_MIN,
} from './constants.js';

/**
 * Inter-send gap jitter (P13 Unit U2, pacing design §2.3, tests 4a/4b -
 * cited by section number, not by the product feature name, for the reason
 * recorded in `constants.ts`'s module doc: naming the feature would oblige
 * this engine module to carry the full user-facing disclaimer verbatim).
 * `drawGapMs` and `applyLongPause` make sending SLOWER, never
 * faster, than a fixed gap - a log-uniform draw plus an occasional long
 * pause is a LESS mechanical, human-like send cadence, and is used here
 * strictly to widen and lengthen the gap, never to shorten it below the
 * resolved `gapMinMs`. This is explicitly NOT a provider-evasion mechanism
 * (core invariant 6): it never helps a message go out faster or bypass a
 * limit, it only ever adds delay and variance on top of an already-resolved
 * floor/ceiling.
 *
 * Pure per `packages/domain`'s browser-purity contract: the RNG is always
 * injected (`Rng` port), never `Math.random()` directly.
 */

/**
 * Log-uniform draw in `[minMs, maxMs]`: more short gaps, a long tail of
 * longer, human-like pauses (as opposed to a uniform draw, which would
 * spend as much density on rare long gaps as common short ones).
 *
 * `gap_min_ms` is a HARD FLOOR - no configuration, jitter draw or code path
 * may ever return a value below `minMs` (and never below
 * `ABSOLUTE_GAP_MIN_MS`, the platform-wide floor). At `rng.random() === 0`,
 * `Math.round(Math.exp(lo + 0 * (hi - lo)))` reduces to exactly
 * `Math.round(Math.exp(lo))` = `Math.round(minMs)` = `minMs` (asserted in
 * the test below) - the defensive `Math.max` clamp exists only to guard
 * against floating-point rounding pushing a result a fraction under `minMs`
 * for values where `Math.exp(Math.log(minMs))` does not round-trip exactly.
 */
export function drawGapMs(minMs: number, maxMs: number, rng: Rng): number {
  if (minMs <= 0 || maxMs < minMs) {
    throw new RangeError(`drawGapMs: invalid bounds minMs=${minMs} maxMs=${maxMs}`);
  }
  const floor = Math.max(minMs, ABSOLUTE_GAP_MIN_MS);
  const lo = Math.log(floor);
  const hi = Math.log(Math.max(maxMs, floor));
  const draw = Math.round(Math.exp(lo + rng.random() * (hi - lo)));
  // Defensive clamp: floating-point Math.exp(Math.log(x)) is not always an
  // exact round-trip, so guard the floor (never the ceiling - the ceiling
  // is exact by construction since rng.random() < 1 keeps the exponent
  // strictly below `hi` and Math.round never rounds a value below `hi` up
  // past `maxMs` by more than the already-safe Math.min below).
  return Math.min(Math.max(draw, floor), Math.round(Math.exp(hi)));
}

/** Caller-supplied send-cadence state - this package holds no module state (pure). */
export interface LongPauseState {
  /** Count of sends since the last long pause fired (0-based, resets to 0 when a pause fires). */
  sendsSinceLastPause: number;
  /** The threshold (drawn once per pause cycle) this cadence is counting toward, in `[18,35]`. */
  nextPauseAtSends: number;
}

export interface LongPauseResult {
  gapMs: number;
  state: LongPauseState;
  fired: boolean;
}

/**
 * Multiplies `baseGapMs` by `uniform(4,9)` and caps at 15 minutes,
 * "firing" (i.e. applying the multiplier) roughly every 18-35 sends - a
 * human-like "stepped away for a while" pause. Never returns a gap smaller
 * than `baseGapMs`: the long pause only ever lengthens the gap.
 */
export function applyLongPause(
  baseGapMs: number,
  state: LongPauseState,
  rng: Rng,
): LongPauseResult {
  const sendsSinceLastPause = state.sendsSinceLastPause + 1;

  if (sendsSinceLastPause < state.nextPauseAtSends) {
    return {
      gapMs: baseGapMs,
      state: { ...state, sendsSinceLastPause },
      fired: false,
    };
  }

  const multiplier =
    LONG_PAUSE_MULTIPLIER_MIN +
    rng.random() * (LONG_PAUSE_MULTIPLIER_MAX - LONG_PAUSE_MULTIPLIER_MIN);
  const gapMs = Math.min(Math.round(baseGapMs * multiplier), LONG_PAUSE_CAP_MS);
  const nextPauseAtSends = drawNextPauseThreshold(rng);

  return {
    gapMs,
    state: { sendsSinceLastPause: 0, nextPauseAtSends },
    fired: true,
  };
}

/** Draws the next long-pause threshold, an integer in `[18,35]` inclusive. */
export function drawNextPauseThreshold(rng: Rng): number {
  const span = LONG_PAUSE_MAX_EVERY_N_SENDS - LONG_PAUSE_MIN_EVERY_N_SENDS;
  return LONG_PAUSE_MIN_EVERY_N_SENDS + Math.floor(rng.random() * (span + 1));
}
