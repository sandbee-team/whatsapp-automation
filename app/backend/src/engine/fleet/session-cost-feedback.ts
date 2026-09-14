import { trimmedMean } from '@wp/domain';
import type { FleetMetricsHandles } from './metrics.js';
import { deriveSessionCapResult, type WorkerBudgetConfig } from './budget.js';

/**
 * engine/fleet/session-cost-feedback.ts (P10 U6 step 9) - the production
 * feedback loop that turns real per-worker RSS-slope measurements into the
 * `measuredSessionMb` cap input (ADR 0018 S3), replacing the one-shot
 * component-A/B measurement (P10 U4 / P10a) with a continuously-updated
 * number.
 *
 * Design (core invariant 2, fail-safe, drives every guard below):
 *   1. Take the 24h **trimmed mean** (drop the top and bottom decile, shared
 *      `trimmedMean` helper from `@wp/domain` - the same one
 *      `scripts/measure/ramp-sessions.ts` uses for its soak averaging, ADR
 *      0018 S3 canon, one implementation) of per-worker RSS-slope samples -
 *      one outlier worker must never move the fleet number
 *      (`trimmed_mean_ignores_the_top_and_bottom_decile`).
 *   2. Guard the day-over-day movement to +/-30% of the CURRENT measured
 *      value - a real regression still gets caught, but a bad sample window
 *      cannot cause a single-day cliff
 *      (`feedback_cannot_move_the_cap_more_than_thirty_percent_in_a_day`).
 *   3. Clamp the resulting measured mb (not the raw candidate) to the same
 *      floor 10 / ceiling 250 that `budget.ts` already enforces on the cap
 *      derivation - one clamp definition, reused.
 *   4. `< 12h` of samples, or none at all, is a NO-OP - the cap and the
 *      measured figure are left exactly where they were, tagged
 *      `provisional`, never guessed at from a thin window
 *      (`a_missing_or_thin_metric_window_leaves_the_cap_unchanged`).
 *   5. The accepted `measuredSessionMb` is turned into `cap` by CALLING
 *      `deriveSessionCapResult` from `./budget.js` (the SAME heap-budget/
 *      baseline/safety-factor arithmetic that turns a per-session MB figure
 *      into a session COUNT everywhere else in the fleet layer) - never a
 *      bare floor/ceiling clamp of the megabyte value itself, which would
 *      silently return a byte figure where a session count is expected (the
 *      bug this fix corrects: `cap_is_derived_from_the_heap_budget_not_the_
 *      megabyte_value`).
 *
 * Pure math only in `computeSessionCostFeedback` - clock and sample series
 * are both plain inputs, no `Date.now()`/timers/I-O here, so every guard is
 * unit-testable without a real 24h wait. The scheduler port
 * (`scheduleDailyRecompute`) is the thin adapter that wires this pure
 * function to a real 24h timer, the fleet metric handles, and a structured
 * log line.
 */

const SESSION_CAP_FLOOR = 10;
const SESSION_CAP_CEILING = 250;
const MIN_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h - below this the window is "thin".
const MAX_DAILY_MOVEMENT_FRACTION = 0.3; // +/-30% per day (ADR 0018 S3).

/** One worker's measured per-session RSS-slope footprint (mb), observed at `takenAt` (wall-clock ms, matching `now`). */
export interface WorkerRssSlopeSample {
  workerId: string;
  sessionMb: number;
  takenAt: number;
}

export type SessionCostFeedbackReason = 'thin-window' | 'rate-limited' | 'accepted';

/**
 * The worker budget knobs `deriveSessionCapResult` needs to turn an accepted
 * `measuredSessionMb` into a session-count `cap` - the SAME four values
 * `roles/session-worker.ts` already reads off `config`
 * (`WORKER_HEAP_BUDGET_MB`/`WORKER_PROCESS_BASELINE_MB`/
 * `WORKER_PLANNED_SESSION_MB`/`WORKER_SESSION_SAFETY_FACTOR`). Excludes
 * `measuredSessionMb` - this function supplies that field itself from the
 * accepted candidate, never from the caller.
 */
export type SessionCostFeedbackBudget = Omit<WorkerBudgetConfig, 'measuredSessionMb'>;

export interface SessionCostFeedbackInput {
  /** All available per-worker slope samples; the function itself filters to the trailing 24h window ending at `now` and checks the window span. */
  samples: readonly WorkerRssSlopeSample[];
  /** Injected clock reading (wall-clock ms) - never `Date.now()` read internally, so tests drive every branch deterministically. */
  now: number;
  /** The measured figure the fleet is currently operating on, if any - `undefined` means "no accepted measurement yet" (still provisional), and the +/-30% guard has nothing to clamp against, so a first-ever measurement is accepted un-rate-limited (still floor/ceiling clamped). */
  currentMeasuredSessionMb?: number;
  /** The cap currently in effect - returned unchanged when this recompute is a no-op. */
  currentCapMb: number;
  /** Worker heap-budget knobs `deriveSessionCapResult` needs to turn the accepted measured mb into a session-count cap (see `SessionCostFeedbackBudget`'s own doc). */
  budget: SessionCostFeedbackBudget;
}

export interface SessionCostFeedbackResult {
  /** `false` for a no-op (thin/missing window) - `currentMeasuredSessionMb`/`currentCapMb` pass straight through. */
  changed: boolean;
  /** `true` when the raw trimmed-mean candidate was reduced to the +/-30% daily movement bound before being applied. */
  clamped: boolean;
  reason: SessionCostFeedbackReason;
  /**
   * The accepted measured mb - either unchanged (`changed: false`, and only
   * when a prior measurement existed; `undefined` when none did - see
   * `hasMeasurement`), the raw trimmed mean (`changed: true, clamped:
   * false`), or the rate-limited value (`changed: true, clamped: true`).
   * Always floor/ceiling-clamped when present.
   */
  measuredSessionMb: number | undefined;
  /**
   * `true` when `measuredSessionMb` carries a real accepted-or-prior
   * measurement; `false` on a thin/missing window with no prior measurement
   * either, in which case `measuredSessionMb` is `undefined` - a thin window
   * must never substitute the session-count `cap` (or anything else) as a
   * stand-in megabyte value (this field exists specifically to make that bug
   * impossible to reintroduce).
   */
  hasMeasurement: boolean;
  /** The session-count cap derived by calling `deriveSessionCapResult` (`./budget.js`) with `measuredSessionMb` fed into the SAME heap-budget arithmetic every other cap in the fleet layer uses - callers feed this straight to the `wp_worker_session_cap` gauge. Never a bare floor/ceiling clamp of the megabyte value itself. */
  cap: number;
  /** `true` when no accepted real measurement backs this result yet (thin window with no prior measurement, or the very first accepted measurement is still surfaced as non-provisional once accepted - see `changed`/`reason`). Mirrors `budget.ts`'s `SessionCapResult.provisional`. */
  provisional: boolean;
}

function clampToFloorCeiling(mb: number): number {
  return Math.min(SESSION_CAP_CEILING, Math.max(SESSION_CAP_FLOOR, mb));
}

/**
 * The pure recompute: trimmed-mean the in-window samples, then apply the
 * +/-30%/day rate limit, and derive `cap` from the accepted measured mb via
 * `deriveSessionCapResult` (never a bare clamp of the megabyte value - see
 * this file's module doc, design step 5). See the module doc for the
 * five-step design each branch below implements.
 */
export function computeSessionCostFeedback(
  input: SessionCostFeedbackInput,
): SessionCostFeedbackResult {
  const windowStart = input.now - 24 * 60 * 60 * 1000;
  const inWindow = input.samples.filter((s) => s.takenAt >= windowStart && s.takenAt <= input.now);

  const oldestInWindow = inWindow.reduce(
    (min, s) => Math.min(min, s.takenAt),
    Number.POSITIVE_INFINITY,
  );
  const spanMs = inWindow.length > 0 ? input.now - oldestInWindow : 0;

  if (inWindow.length === 0 || spanMs < MIN_WINDOW_MS) {
    // Fail-safe (core invariant 2): a missing/thin window NEVER moves the
    // cap - the caller's existing measured mb/cap pass straight through,
    // still (or newly) tagged provisional. `measuredSessionMb` stays
    // `undefined` when there was no PRIOR measurement either - it must never
    // silently substitute `currentCapMb` (a session COUNT) as a stand-in
    // megabyte value (the CRITICAL-1 unit bug this fix corrects).
    const priorCapResult = deriveSessionCapResult({
      ...input.budget,
      measuredSessionMb: input.currentMeasuredSessionMb,
    });
    return {
      changed: false,
      clamped: false,
      reason: 'thin-window',
      measuredSessionMb: input.currentMeasuredSessionMb,
      hasMeasurement: input.currentMeasuredSessionMb !== undefined,
      cap: input.currentMeasuredSessionMb === undefined ? input.currentCapMb : priorCapResult.cap,
      provisional: true,
    };
  }

  const rawCandidate = trimmedMean(inWindow.map((s) => s.sessionMb));

  let accepted = rawCandidate;
  let clamped = false;
  let reason: SessionCostFeedbackReason = 'accepted';

  if (input.currentMeasuredSessionMb !== undefined && input.currentMeasuredSessionMb > 0) {
    const maxUp = input.currentMeasuredSessionMb * (1 + MAX_DAILY_MOVEMENT_FRACTION);
    const maxDown = input.currentMeasuredSessionMb * (1 - MAX_DAILY_MOVEMENT_FRACTION);
    if (rawCandidate > maxUp || rawCandidate < maxDown) {
      accepted = Math.min(maxUp, Math.max(maxDown, rawCandidate));
      clamped = true;
      reason = 'rate-limited';
    }
  }

  const measuredSessionMb = clampToFloorCeiling(accepted);
  const capResult = deriveSessionCapResult({ ...input.budget, measuredSessionMb });

  return {
    changed: true,
    clamped,
    reason,
    measuredSessionMb,
    hasMeasurement: true,
    cap: capResult.cap,
    provisional: false,
  };
}

// ---------------------------------------------------------------------
// Scheduler port - thin adapter wiring the pure fn above to a real 24h
// timer, the fleet metric gauges, and a structured (ids-only) log line. NO
// math lives here - every branch above is already covered by the pure unit
// tests; this is I/O plumbing only.
// ---------------------------------------------------------------------

export interface ScheduleDailyRecomputeDeps {
  /** Reads the trailing sample series for ALL workers this recompute covers - injected so the caller owns where samples are stored (metrics backend, in-memory ring, etc). */
  readSamples(): Promise<readonly WorkerRssSlopeSample[]> | readonly WorkerRssSlopeSample[];
  getCurrentMeasuredSessionMb(): number | undefined;
  getCurrentCapMb(): number;
  /** Worker heap-budget knobs threaded straight through to `computeSessionCostFeedback` on every cycle - see `SessionCostFeedbackBudget`'s own doc. */
  budget: SessionCostFeedbackBudget;
  /** Applies the accepted result so the NEXT recompute's `currentMeasuredSessionMb`/`currentCapMb` reflect it, and so the live session cap actually moves. */
  applyResult(result: SessionCostFeedbackResult): void;
  metrics: Pick<FleetMetricsHandles, 'workerSessionCap' | 'sessionMeasuredMb'>;
  logger: { warn(msg: string, meta?: Record<string, unknown>): void };
  now?: () => number;
  intervalMs?: number;
  workerId: string;
}

export interface DailyRecomputeHandle {
  stop(): void;
  /** Runs one recompute cycle immediately (also used by the internal timer) - exposed for tests that don't want to wait on a real interval. */
  runOnce(): Promise<void>;
}

const DEFAULT_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Wires `computeSessionCostFeedback` to a 24h timer (default; overridable
 * for tests), applying the result via `deps.applyResult`, emitting
 * `wp_worker_session_cap` (new cap) and `wp_session_measured_mb` (accepted
 * measured mb) on every cycle - INCLUDING a no-op cycle, so the gauges
 * always reflect the current, possibly-still-provisional state - and
 * logging a structured (ids-only) warning when a cycle is rate-limited or
 * thin, per this module's own fail-safe doc.
 */
export function scheduleDailyRecompute(deps: ScheduleDailyRecomputeDeps): DailyRecomputeHandle {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_RECOMPUTE_INTERVAL_MS;

  async function runOnce(): Promise<void> {
    const samples = await deps.readSamples();
    const result = computeSessionCostFeedback({
      samples,
      now: now(),
      currentMeasuredSessionMb: deps.getCurrentMeasuredSessionMb(),
      currentCapMb: deps.getCurrentCapMb(),
      budget: deps.budget,
    });

    deps.applyResult(result);
    deps.metrics.workerSessionCap.set(result.cap);
    // A thin/missing window with no prior measurement leaves
    // `measuredSessionMb` `undefined` (see `hasMeasurement`) - the gauge has
    // nothing real to report yet, so it is left untouched rather than fed a
    // fabricated value (e.g. the session-count cap, the CRITICAL-1 bug this
    // fix corrects).
    if (result.measuredSessionMb !== undefined) {
      deps.metrics.sessionMeasuredMb.set(result.measuredSessionMb);
    }

    if (result.reason !== 'accepted') {
      deps.logger.warn('session-cost-feedback cycle did not apply a raw measurement', {
        workerId: deps.workerId,
        reason: result.reason,
        clamped: result.clamped,
        changed: result.changed,
      });
    }
  }

  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
