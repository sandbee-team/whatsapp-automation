import type { AdmissionController, AdmissionState, InstanceId, WorkerSample } from './types.js';

/**
 * admission.ts (P09 Unit U2 step 3) - `AdmissionController`: decides
 * whether THIS worker keeps grabbing/accepting session leases, based on a
 * 3-consecutive-sample trend (never a single spike) fed by a 5s sampler
 * this module does not itself run.
 *
 * State thresholds (canon, phase P09 step 3):
 *   - `holding`  (stop grabbing new leases) when, sustained across the last
 *     3 samples: sessions >= cap, OR rss > 80% of budgetBytes, OR
 *     eventLoopLagP99Ms > 200.
 *   - `shedding` (actively evict sessions to other workers) when, sustained
 *     across the last 3 samples, rss > 92% of budgetBytes - BUT ONLY while
 *     fleet-wide headroom > 0. At zero/unknown (null) headroom the worker
 *     DEGRADES IN PLACE instead (core invariant 2, fail-safe: shedding into
 *     a fleet with no spare capacity just re-triggers the same shed
 *     forever - scope-delta row 11): stop claiming/accepting leases (same
 *     `ok: false` as holding), never call `victimChooser`, never touch a
 *     socket, and raise a capacity alert once per sustained episode.
 *   - `draining` is set externally via `beginDrain()` and is terminal for
 *     the process lifetime - `canAcceptLease()` is always false afterward,
 *     regardless of subsequent samples.
 *
 * `null` fleet headroom means "unknown", and unknown is treated as ZERO
 * (fail-safe: never shed into a fleet whose capacity we can't see).
 *
 * Thrashing: a worker that enters `shedding` 3 separate times within a
 * rolling 1-hour window raises `worker.thrashing` once per crossing (a
 * counter reset only happens by aging entries older than 1h out of the
 * window, never by an explicit reset call).
 */

const HOLD_RSS_FRACTION = 0.8;
const SHED_RSS_FRACTION = 0.92;
const HOLD_LAG_MS = 200;
const TREND_SAMPLES = 3;
const THRASH_WINDOW_MS = 60 * 60 * 1000;
const THRASH_EPISODE_THRESHOLD = 3;

export interface CreateAdmissionControllerOptions {
  getCap(): number;
  /** RSS budget in bytes. */
  budgetBytes: number;
  /** `null` = unknown; treated as ZERO (fail-safe: never shed into an unknown fleet). */
  getFleetHeadroom(): number | null;
  victimChooser: (n: number) => InstanceId[];
  raiseCapacityAlert(reason: string): void;
  raiseThrashing(): void;
  now(): number;
}

function isHoldingSample(s: WorkerSample, cap: number, budgetBytes: number): boolean {
  return (
    s.sessions >= cap ||
    s.rssBytes > budgetBytes * HOLD_RSS_FRACTION ||
    s.eventLoopLagP99Ms > HOLD_LAG_MS
  );
}

function isShedCandidateSample(s: WorkerSample, budgetBytes: number): boolean {
  return s.rssBytes > budgetBytes * SHED_RSS_FRACTION;
}

export function createAdmissionController(
  options: CreateAdmissionControllerOptions,
): AdmissionController & { beginDrain(): void } {
  const {
    getCap,
    budgetBytes,
    getFleetHeadroom,
    victimChooser,
    raiseCapacityAlert,
    raiseThrashing,
    now,
  } = options;

  const samples: WorkerSample[] = [];
  let draining = false;
  /** True while the last computed state was `shedding` OR degrade-in-place - used to fire `raiseCapacityAlert` once per sustained episode, not once per sample. */
  let inDegradeEpisode = false;
  /** Timestamps (via `now()`) of shed-episode STARTS, for the 1h thrashing window. */
  const shedEpisodeStarts: number[] = [];
  let inShedEpisode = false;

  function lastTrend(): WorkerSample[] {
    return samples.slice(-TREND_SAMPLES);
  }

  function pruneThrashWindow(): void {
    const cutoff = now() - THRASH_WINDOW_MS;
    while (shedEpisodeStarts.length > 0 && (shedEpisodeStarts[0] ?? Infinity) < cutoff) {
      shedEpisodeStarts.shift();
    }
  }

  function computeState(): AdmissionState {
    if (draining) {
      return 'draining';
    }

    const trend = lastTrend();
    if (trend.length < TREND_SAMPLES) {
      return 'accepting';
    }

    const cap = getCap();
    const holding = trend.every((s) => isHoldingSample(s, cap, budgetBytes));
    const shedCandidate = trend.every((s) => isShedCandidateSample(s, budgetBytes));

    if (shedCandidate) {
      const headroom = getFleetHeadroom();
      const effectiveHeadroom = headroom ?? 0;
      if (effectiveHeadroom > 0) {
        return 'shedding';
      }
      // Zero/unknown headroom: degrade in place - reported as `holding`
      // (stop claiming/accepting), never `shedding`.
      return 'holding';
    }

    if (holding) {
      return 'holding';
    }

    return 'accepting';
  }

  /**
   * SUGGESTION FIX 9: `computeState()` intentionally reports degrade-in-
   * place (92% rss + zero/unknown fleet headroom) as the SAME `state:
   * 'holding'` a plain cap/rss/lag hold uses (never a new `AdmissionState`
   * union member - `canAcceptLease()`'s `ok: false` behavior is identical
   * for both), but the two conditions are operationally very different: a
   * plain hold clears itself once ANY one of cap/rss/lag drops back below
   * threshold, while degrade-in-place persists until fleet-wide headroom
   * frees up. `reasonFor` re-derives which condition is CURRENTLY live from
   * the same trend `computeState` just consumed, so the reported reason
   * string names the live condition instead of collapsing both into one
   * generic message.
   */
  function reasonFor(state: AdmissionState, trend: WorkerSample[]): string | undefined {
    switch (state) {
      case 'holding': {
        if (
          trend.length >= TREND_SAMPLES &&
          trend.every((s) => isShedCandidateSample(s, budgetBytes))
        ) {
          return 'sustained rss > 92% budget with zero fleet headroom - degrading in place';
        }
        return 'sustained cap/rss/lag threshold';
      }
      case 'shedding':
        return 'sustained rss > 92% budget with fleet headroom available';
      case 'draining':
        return 'draining';
      default:
        return undefined;
    }
  }

  return {
    onSample(s: WorkerSample): void {
      samples.push(s);

      const trend = lastTrend();
      if (trend.length < TREND_SAMPLES || draining) {
        return;
      }

      const shedCandidate = trend.every((sample) => isShedCandidateSample(sample, budgetBytes));

      if (!shedCandidate) {
        inDegradeEpisode = false;
        inShedEpisode = false;
        return;
      }

      const headroom = getFleetHeadroom();
      const effectiveHeadroom = headroom ?? 0;

      if (effectiveHeadroom > 0) {
        // Real shedding episode - victim selection is delegated to shed.ts
        // (a parallel unit); this controller only decides WHEN to shed and
        // tracks thrashing.
        if (!inShedEpisode) {
          inShedEpisode = true;
          pruneThrashWindow();
          shedEpisodeStarts.push(now());
          pruneThrashWindow();
          if (shedEpisodeStarts.length >= THRASH_EPISODE_THRESHOLD) {
            raiseThrashing();
            shedEpisodeStarts.length = 0;
          }
        }
        // Victim selection itself is delegated to `chooseShedVictims` (a
        // thin wrapper over the injected `victimChooser`, the real
        // selection logic lands in shed.ts in a parallel unit) - `onSample`
        // only decides WHEN a shed episode starts and tracks thrashing.
        inDegradeEpisode = false;
        return;
      }

      // Zero/unknown headroom: degrade in place instead of shedding.
      inShedEpisode = false;
      if (!inDegradeEpisode) {
        inDegradeEpisode = true;
        raiseCapacityAlert('rss > 92% of budget with zero fleet headroom - degrading in place');
      }
    },

    canAcceptLease(): { ok: boolean; state: AdmissionState; reason?: string } {
      const state = computeState();
      const ok = state === 'accepting';
      const reason = reasonFor(state, lastTrend());
      return reason === undefined ? { ok, state } : { ok, state, reason };
    },

    chooseShedVictims(n: number): InstanceId[] {
      return victimChooser(n);
    },

    beginDrain(): void {
      draining = true;
    },
  };
}
