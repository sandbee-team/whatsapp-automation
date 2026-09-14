import os from 'node:os';
import type { WorkerSample } from './types.js';

/**
 * engine/fleet/sampler.ts (P09 Unit U1) - the 5 s worker sampler that
 * produces `WorkerSample`s and feeds the six fleet metrics in `metrics.ts`.
 * All inputs (clock, session/cap getters, memory/event-loop readers) are
 * dependency-injected so unit tests can drive the sampler deterministically
 * without real timers or a real process - see `createFleetSampler`.
 *
 * `WorkerSample` is imported from the shared `./types.js` (the parallel U2
 * admission-controller unit's canonical shape) rather than redeclared here,
 * so this sampler's output is directly consumable by `AdmissionController.
 * onSample` without an adapter. This module still does not import
 * `admission.ts` itself - the admission controller subscribes to `onSample`
 * at composition time, not here.
 */

export type { WorkerSample };

/** One (session-count, rss) observation in the slope estimator's ring buffer. */
export interface SessionRssPoint {
  sessions: number;
  rssBytes: number;
}

/**
 * Least-squares slope of `rssBytes` vs `sessions` over `points` (bytes per
 * session). This is deliberately NOT `rss / sessions` - that ratio bakes in
 * the fixed process baseline (Node runtime, loaded modules, connection
 * pools, etc.) and wildly overstates the marginal cost of one more session.
 * The slope of the regression line isolates the marginal (per-session) cost
 * by design.
 *
 * Returns `null` (never a garbage division) when there are fewer than two
 * points, or when the session-count variance across `points` is ~0 (a flat
 * or near-flat x-series makes the slope numerically unstable/undefined -
 * publish nothing rather than a meaningless huge or NaN estimate).
 */
export function estimateSessionRssSlopeBytes(points: readonly SessionRssPoint[]): number | null {
  const n = points.length;
  if (n < 2) {
    return null;
  }

  const meanSessions = points.reduce((sum, p) => sum + p.sessions, 0) / n;
  const meanRss = points.reduce((sum, p) => sum + p.rssBytes, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    const dx = p.sessions - meanSessions;
    numerator += dx * (p.rssBytes - meanRss);
    denominator += dx * dx;
  }

  // denominator ~ 0 means session count barely varied across the window -
  // the slope is undefined/unstable, not "small". Guard with a relative
  // epsilon rather than an exact zero check.
  const EPSILON = 1e-9;
  if (denominator < EPSILON) {
    return null;
  }

  const slope = numerator / denominator;
  if (!Number.isFinite(slope)) {
    return null;
  }
  return slope;
}

/**
 * Bounded ring buffer of the most recent points, oldest evicted first once
 * `capacity` is exceeded. Defaults its element type to `SessionRssPoint`
 * (this module's own original, and still most common, use) but is generic so
 * OTHER bounded in-memory series with the exact same "push, evict oldest,
 * snapshot" shape (e.g. `session-cost-feedback-timer.ts`'s frequent-cadence
 * `WorkerRssSlopeSample` series, FIX-P10-A CRITICAL 3) reuse this storage
 * rather than reimplementing the same bounded-array pattern.
 */
export class SessionRssRingBuffer<T = SessionRssPoint> {
  private readonly points: T[] = [];

  constructor(private readonly capacity: number) {
    if (capacity < 2) {
      throw new Error(`SessionRssRingBuffer capacity must be >= 2, got ${capacity}`);
    }
  }

  push(point: T): void {
    this.points.push(point);
    if (this.points.length > this.capacity) {
      this.points.shift();
    }
  }

  snapshot(): readonly T[] {
    return [...this.points];
  }
}

/** Injected readers so the sampler needs no real process/timers under test. */
export interface FleetSamplerDeps {
  now: () => number;
  getSessions: () => number;
  getCap: () => number;
  readRssBytes: () => number;
  readHeapOldSpaceBytes: () => number;
  readEventLoopLagP99Ms: () => number;
  readGcPauseP99Ms: () => number;
  readBoxRssBytes?: () => number;
  ringBufferCapacity?: number;
}

export interface FleetSampler {
  /** Takes one sample immediately, records it, and invokes onSample. */
  sampleOnce: () => WorkerSample;
  /** Current session-vs-rss slope estimate (bytes/session), or null. */
  currentSessionRssSlopeBytes: () => number | null;
}

const DEFAULT_RING_BUFFER_CAPACITY = 60; // 5 minutes of history at a 5s cadence

/** Default box-level RSS reader: os.totalmem() - os.freemem() (the HOST gauge). */
export function defaultReadBoxRssBytes(): number {
  return os.totalmem() - os.freemem();
}

/**
 * Builds a sampler that, each time `sampleOnce()` is invoked (the caller
 * owns the 5 s interval - this module does not start its own timer, keeping
 * it trivially testable), reads the injected sources, records a
 * (sessions, rss) point into a bounded ring buffer, and calls `onSample`
 * with the resulting `WorkerSample`.
 */
export function createFleetSampler(
  deps: FleetSamplerDeps,
  onSample: (s: WorkerSample) => void,
): FleetSampler {
  const ring = new SessionRssRingBuffer(deps.ringBufferCapacity ?? DEFAULT_RING_BUFFER_CAPACITY);

  function sampleOnce(): WorkerSample {
    const sessions = deps.getSessions();
    const rssBytes = deps.readRssBytes();

    ring.push({ sessions, rssBytes });

    const sample: WorkerSample = {
      sessions,
      rssBytes,
      heapOldSpaceBytes: deps.readHeapOldSpaceBytes(),
      eventLoopLagP99Ms: deps.readEventLoopLagP99Ms(),
      gcPauseP99Ms: deps.readGcPauseP99Ms(),
      takenAt: deps.now(),
    };

    onSample(sample);
    return sample;
  }

  function currentSessionRssSlopeBytes(): number | null {
    return estimateSessionRssSlopeBytes(ring.snapshot());
  }

  return { sampleOnce, currentSessionRssSlopeBytes };
}
