/**
 * cron-loop.ts (P12 Unit U4, step 7) - the generic bounded-batch ticker
 * `roles/cron.ts` composes twice (once per cadence: reaper 15s, reconciler
 * 30s +/- jitter). Timer/skip-guard shape mirrors
 * `modules/realtime/authz-tick.ts`'s own `createAuthzTick` exactly: a single
 * fixed-cadence `setInterval` plus a `tickInFlight` boolean single-flight
 * guard - if the previous tick's `runOne()` is still in flight when the
 * interval fires again, that fire is SKIPPED entirely (never queued, never
 * overlapped); the next interval fire after the in-flight call settles
 * starts a fresh tick.
 *
 * Each tick that actually runs invokes `runOne()` (typically
 * `runWithSingleFlightLock` wrapping the loop's real DB work) and reports
 * its `SingleFlightOutcome` via `onOutcome` for metrics/logging -
 * `lock_not_acquired` (a second cron process holds the Postgres advisory
 * lock right now) is a normal no-op, never logged at error level;
 * `db_error` counts toward a bounded backoff applied to the loop's own
 * INTERVAL going forward (re-armed via `clearIntervalFn`/`setIntervalFn` on
 * the next scheduling decision) - any later `ran`/`lock_not_acquired`
 * outcome resets it back to the plain base interval.
 *
 * ADR 0018 S4 ("no singleton loop may be O(active) faster than 5 minutes"):
 * this ticker's own cadence is a fixed interval independent of fleet size
 * (15s/30s) - `runOne` is a single bounded-`LIMIT` batch sweep, never
 * per-instance, so this loop's frequency never scales with active count.
 */

export type CronTickOutcome = 'ran' | 'lock_not_acquired' | 'db_error' | 'skipped_overlap';

export interface CronLoopDeps {
  /** Runs one tick's real work; returns the outcome so the loop can report/backoff on it. Must never throw - any DB error is already captured as `{ outcome: 'db_error', error }` (see `single-flight.ts`). */
  runOne: () => Promise<{ outcome: 'ran' | 'lock_not_acquired' | 'db_error'; error?: unknown }>;
  /** Base interval between tick attempts, in ms (e.g. 15_000 for the reaper). */
  intervalMs: number;
  /** Optional symmetric jitter applied to `intervalMs`, in ms (e.g. reconciler's 30s +/- jitter). Omitted/0 means no jitter (reaper). Re-sampled every time the interval is (re)armed. */
  jitterMs?: number;
  /** `[0, 1)` RNG contract, same as `@wp/domain`'s `Rng` - injected so jitter is deterministic under test, never `Math.random()` at the call site. */
  rng?: { random: () => number };
  /** Bounded backoff schedule applied on consecutive `db_error` outcomes, in ms, ADDED on top of the jittered base interval - e.g. `[5_000, 15_000]`; a longer error streak repeats the LAST entry rather than growing without bound. */
  backoffScheduleMs?: readonly number[];
  /** `error` is present only for a `db_error` outcome (M3 fix - `runOne`'s own `result.error` was previously discarded here, so every caller's own `logOutcome` always rendered the literal `undefined`). */
  onOutcome?: (outcome: CronTickOutcome, error?: unknown) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface CronLoop {
  start: () => void;
  stop: () => void;
}

function jitteredIntervalMs(
  intervalMs: number,
  jitterMs: number,
  rng: { random: () => number },
): number {
  if (jitterMs <= 0) return intervalMs;
  return intervalMs + (rng.random() * 2 - 1) * jitterMs;
}

/** Builds one cron loop. Nothing runs until `start()` is called; `stop()` cancels the interval (an in-flight tick is left to finish, but no further tick fires after it). */
export function createCronLoop(deps: CronLoopDeps): CronLoop {
  const jitterMs = deps.jitterMs ?? 0;
  const rng = deps.rng ?? { random: () => 0.5 };
  const backoffScheduleMs = deps.backoffScheduleMs ?? [];
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  let handle: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;
  let consecutiveErrors = 0;

  function currentIntervalMs(): number {
    const base = jitteredIntervalMs(deps.intervalMs, jitterMs, rng);
    if (consecutiveErrors === 0 || backoffScheduleMs.length === 0) {
      return base;
    }
    const step = backoffScheduleMs[Math.min(consecutiveErrors, backoffScheduleMs.length) - 1];
    return base + (step ?? 0);
  }

  function rearm(): void {
    if (handle !== undefined) {
      clearIntervalFn(handle);
    }
    handle = setIntervalFn(onTick, currentIntervalMs());
  }

  function onTick(): void {
    if (tickInFlight) {
      deps.onOutcome?.('skipped_overlap');
      return;
    }
    tickInFlight = true;
    void deps
      .runOne()
      .then((result) => {
        const errorStreakBefore = consecutiveErrors;
        consecutiveErrors = result.outcome === 'db_error' ? consecutiveErrors + 1 : 0;
        // Only pass a second arg when an error is actually present - keeps
        // the call shape for every non-`db_error` outcome IDENTICAL to
        // before this fix (`onOutcome('ran')`, not `onOutcome('ran',
        // undefined)`), which is what every OTHER caller's own tests assert
        // exactly (`cron-loop.test.ts`'s `toHaveBeenCalledExactlyOnceWith`/
        // `toHaveBeenNthCalledWith` cases).
        if (result.error !== undefined) {
          deps.onOutcome?.(result.outcome, result.error);
        } else {
          deps.onOutcome?.(result.outcome);
        }
        // Only re-arm the interval when the backoff state actually changed
        // (entered or left an error streak) - a steady run of successes (or
        // a steady run of errors already at the schedule's last step) keeps
        // the SAME interval handle, so `clearIntervalFn`/`setIntervalFn`
        // churn stays proportional to actual state transitions, not ticks.
        if (errorStreakBefore !== consecutiveErrors) {
          rearm();
        }
      })
      .finally(() => {
        tickInFlight = false;
      });
  }

  return {
    start(): void {
      if (handle !== undefined) return;
      rearm();
    },
    stop(): void {
      if (handle !== undefined) {
        clearIntervalFn(handle);
        handle = undefined;
      }
    },
  };
}
