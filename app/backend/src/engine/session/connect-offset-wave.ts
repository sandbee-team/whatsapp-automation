import { DEFAULT_PER_WORKER_BURST } from './connect-gate.js';

/**
 * connect-offset-wave.ts (P09 U6b) - the pure "is this grab part of a
 * connect-STORM wave?" decision `session-worker-composition.ts`'s discovery
 * `grab` wrapper consults for every row ONE discovery cycle attempts to
 * grab. Split out as its own tiny pure module (no I/O, no imports beyond the
 * named burst constant) so the counting rule is unit-testable without a real
 * discovery cycle/Postgres/Redis.
 *
 * Rule: within ONE discovery cycle (`beginCycle()` resets the counter), the
 * first `CONNECT_OFFSET_WAVE_THRESHOLD` grab attempts are NOT a wave (a
 * cycle that only ever needs to grab a handful of instances is ordinary
 * churn, not a fleet-wide reconnect storm); the threshold as `getCurrentSessions()`
 * grows past whatever ordinary +1/-1 churn looks like, `attemptedThisCycle`
 * exceeding it is the wave signal. `noteGrabAttempt()` is called once per
 * `grab(row)` invocation, in the SAME order `discovery.ts`'s own `for (const
 * row of rows)` loop calls it - discovery cycles never run concurrently (one
 * worker's `runOneDiscoveryCycle` is always awaited to completion before the
 * next), so a single mutable counter reset per cycle is safe with no locking.
 */

/** Re-exported under this module's own name (task requirement: name the threshold constant here, not just at connect-gate.ts's own definition site). */
export const CONNECT_OFFSET_WAVE_THRESHOLD = DEFAULT_PER_WORKER_BURST;

export interface WaveConnectTracker {
  /** Resets the per-cycle attempt counter to 0 - call once at the start of every discovery cycle. */
  beginCycle(): void;
  /** Records one grab attempt and returns whether THIS attempt is wave-tagged (attempt count so far > threshold). */
  noteGrabAttempt(): boolean;
}

export function createWaveConnectTracker(
  threshold: number = CONNECT_OFFSET_WAVE_THRESHOLD,
): WaveConnectTracker {
  let attemptedThisCycle = 0;

  return {
    beginCycle(): void {
      attemptedThisCycle = 0;
    },
    noteGrabAttempt(): boolean {
      attemptedThisCycle += 1;
      return attemptedThisCycle > threshold;
    },
  };
}
