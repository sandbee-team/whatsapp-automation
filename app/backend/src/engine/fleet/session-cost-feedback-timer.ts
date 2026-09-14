import { logger } from '@wp/server-kit';
import { bindFleetMetrics } from './metrics.js';
import { SessionRssRingBuffer } from './sampler.js';
import {
  scheduleDailyRecompute,
  type SessionCostFeedbackBudget,
  type WorkerRssSlopeSample,
} from './session-cost-feedback.js';

/**
 * engine/fleet/session-cost-feedback-timer.ts (P10 U6 step 9; cadence fixed
 * FIX-P10-A CRITICAL 3) - the thin `roles/session-worker.ts` call site for
 * the production-feedback recompute, mechanically split out (mirrors the
 * discovery-wiring split in `engine/session/session-worker-discovery-wiring.
 * ts`) so `roles/**` stays thin and this role file does not breach the
 * max-lines cap. All the actual math lives in `session-cost-feedback.ts`'s
 * pure `computeSessionCostFeedback` - this module only supplies the concrete
 * sample source, the mutable measured-mb/cap state the recompute reads and
 * writes, the worker heap-budget config that turns an accepted measured mb
 * into a session-count cap (FIX-P10-A CRITICAL 1), and the `@wp/server-kit`
 * logger/metrics registry.
 *
 * CRITICAL 3 fix (cadence): before this fix, one sample was appended per
 * 24h recompute cycle, so a >=12h window needed 2 cycles (48h uptime) and a
 * trimmable (>=10 point) series needed ~240 DAYS - the loop was, in
 * practice, permanently stuck on `thin-window`. This module now runs TWO
 * timers instead of one:
 *   - a FREQUENT sampler (`SAMPLE_INTERVAL_MS`, default 5 minutes) that
 *     reads the worker's current RSS-slope estimate and pushes one point
 *     into a bounded `SessionRssRingBuffer<WorkerRssSlopeSample>` (reusing
 *     `sampler.ts`'s existing bounded-ring-buffer storage, generic-ized for
 *     this element shape, rather than inventing a second one) sized to hold
 *     slightly over 24h of samples at that cadence
 *     (`SAMPLE_RING_CAPACITY_FOR_24H`);
 *   - the existing daily recompute (`scheduleDailyRecompute`, still default
 *     24h, overridable via `recomputeIntervalMs`) reads the ring's snapshot
 *     as `samples` on every cycle.
 * At 5-minute sampling, a 24h window holds ~288 points - comfortably over
 * the >=10 needed for the trimmed-mean's decile trim to engage, and the
 * >=12h span requirement is reachable after ~12h of worker uptime instead of
 * 48h+. The series is STILL in-memory only and resets to empty on a process
 * restart (no persistence layer here) - `docs/capacity/session-cost.md` is
 * updated to state this explicitly rather than imply cross-restart
 * continuity.
 */

const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes.
const DEFAULT_RECOMPUTE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours (unchanged default).
// Slightly over 24h of headroom at the default 5-minute cadence (288
// points/24h) so a recompute that runs a little late never finds its oldest
// sample already evicted.
const SAMPLE_RING_CAPACITY_FOR_24H = 300;

export interface BuildSessionCostFeedbackTimerOptions {
  workerId: string;
  /**
   * Reads this worker's own current RSS-slope estimate (mb) - the SAME
   * estimator `sampler.ts`'s `currentSessionRssSlopeBytes` exposes (bytes,
   * converted to mb by the caller), one sample per call, timestamped `now()`
   * at call time. `undefined` means no estimate is available yet (e.g. too
   * few ring-buffer points, or the fleet runtime does not expose this
   * worker's sampler handle to the caller yet); the sample is skipped for
   * this cycle rather than fabricated - a missing/thin window is exactly
   * what `computeSessionCostFeedback` already treats as a fail-safe no-op.
   */
  readCurrentSessionRssSlopeMb(): number | undefined;
  getCurrentMeasuredSessionMb(): number | undefined;
  getCurrentCapMb(): number;
  /** Worker heap-budget knobs fed to `deriveSessionCapResult` on every recompute cycle - see `SessionCostFeedbackBudget`'s own doc. */
  budget: SessionCostFeedbackBudget;
  onApplied(measuredSessionMb: number, capMb: number): void;
  now?: () => number;
  /** Cadence of the frequent sampler timer feeding the ring buffer. Defaults to `DEFAULT_SAMPLE_INTERVAL_MS` (5 min); overridable for tests. */
  sampleIntervalMs?: number;
  /** Cadence of the daily recompute timer (unchanged 24h default). `intervalMs` (the pre-fix option name) is still accepted as an alias for one release for callers that have not migrated yet. */
  recomputeIntervalMs?: number;
  /** @deprecated use `recomputeIntervalMs` - kept as an alias so existing tests/call sites are not silently broken by the rename. */
  intervalMs?: number;
  /** Ring buffer capacity override, mainly for tests that want a tiny buffer to prove the eviction boundary without waiting on 300 real samples. */
  sampleRingCapacity?: number;
}

export interface SessionCostFeedbackTimerHandle {
  stop(): void;
  /** Runs one recompute cycle immediately against whatever samples are currently in the ring (also used by the internal daily timer) - exposed for tests that don't want to wait on real timers. */
  runOnce(): Promise<void>;
  /** Takes one sample immediately and pushes it into the ring (also used by the internal frequent-sampler timer) - exposed for tests that want to drive the ring deterministically without a real interval. */
  sampleOnce(): void;
}

/**
 * Wires TWO timers - a frequent sampler feeding a bounded ring buffer, and
 * the existing `scheduleDailyRecompute` reading that ring's snapshot - so a
 * >=12h window and a >=10-point trimmed mean are both reachable within a
 * normal worker uptime (see this file's module doc, CRITICAL 3 fix). Returns
 * `stop`/`runOnce`/`sampleOnce` so the caller (and tests) can drive or halt
 * either timer without waiting on real intervals.
 */
export function buildSessionCostFeedbackTimer(
  options: BuildSessionCostFeedbackTimerOptions,
): SessionCostFeedbackTimerHandle {
  const now = options.now ?? Date.now;
  const ring = new SessionRssRingBuffer<WorkerRssSlopeSample>(
    options.sampleRingCapacity ?? SAMPLE_RING_CAPACITY_FOR_24H,
  );

  function sampleOnce(): void {
    const slopeMb = options.readCurrentSessionRssSlopeMb();
    if (slopeMb !== undefined) {
      ring.push({ workerId: options.workerId, sessionMb: slopeMb, takenAt: now() });
    }
  }

  const recompute = scheduleDailyRecompute({
    workerId: options.workerId,
    now,
    metrics: bindFleetMetrics(),
    logger: {
      warn: (msg, meta) => {
        logger.warn({}, meta ? `${msg} ${JSON.stringify(meta)}` : msg);
      },
    },
    getCurrentMeasuredSessionMb: options.getCurrentMeasuredSessionMb,
    getCurrentCapMb: options.getCurrentCapMb,
    budget: options.budget,
    readSamples: () => ring.snapshot(),
    applyResult: (result) => {
      // `changed: true` is only ever returned alongside `hasMeasurement:
      // true` (see `computeSessionCostFeedback`'s accepted branch) - the
      // `undefined` case is exclusively the thin-window no-op path, which is
      // always `changed: false` and never reaches here.
      if (result.changed && result.measuredSessionMb !== undefined) {
        options.onApplied(result.measuredSessionMb, result.cap);
      }
    },
    intervalMs: options.recomputeIntervalMs ?? options.intervalMs ?? DEFAULT_RECOMPUTE_INTERVAL_MS,
  });

  const sampleTimer = setInterval(
    sampleOnce,
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
  );

  return {
    stop: () => {
      clearInterval(sampleTimer);
      recompute.stop();
    },
    runOnce: recompute.runOnce,
    sampleOnce,
  };
}
