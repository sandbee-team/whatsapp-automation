/**
 * Least-squares fit of RSS-vs-session-count ramp measurements (P10 Unit U1).
 *
 * Sizing a fleet from a handful of ramp points invites a classic error:
 * dividing total measured RSS by total sessions ("total/N"). That conflates
 * the fixed socket/runtime baseline with the marginal per-session cost, and
 * badly overstates the per-session figure (see the
 * `slope_is_fitted_not_total_over_sessions` fixture). This module fits an
 * ordinary least-squares line `rssMb = intercept + slope * sessions` instead,
 * so `slope` is the true marginal MB/session and `intercept` is the fixed
 * baseline (socket/runtime overhead independent of session count).
 *
 * Requires >= 4 ramp points (rejects fewer with a named error) and requires
 * more than one distinct `sessions` value (slope is undefined on a single
 * x-value - the "identical x" degenerate case).
 *
 * Also reports R² (goodness of fit) and a 95% two-sided confidence interval
 * on the slope. The OLS arithmetic and the Student-t lookup table now live in
 * `least-squares.ts` (P26 Unit U1, step 1) - this module maps `{sessions,
 * rssMb}` points to `{x, y}`, enforces the `sessions`-specific minimum-point
 * rule, and re-exports the shared error classes/types from their new home so
 * every existing import path here keeps working unchanged.
 *
 * Pure and deterministic: no I/O, no Date, no RNG, no Node builtins.
 */
import { fitLeastSquares } from './least-squares.js';
import type { XyPoint } from './least-squares.js';

export class TooFewRampPointsError extends Error {
  readonly pointCount: number;

  constructor(pointCount: number) {
    super(`fitRssRegression: need >= 4 ramp points, got ${pointCount}`);
    this.name = 'TooFewRampPointsError';
    this.pointCount = pointCount;
  }
}

export class DegenerateRampPointsError extends Error {
  constructor() {
    super(
      'fitRssRegression: all ramp points have the identical "sessions" value - slope is undefined (zero x variance)',
    );
    this.name = 'DegenerateRampPointsError';
  }
}

/**
 * Thrown when every `rssMb` value is identical (zero y-variance, `ssTot ===
 * 0`) - SUGGESTION 14, FIX-P10-A. A perfectly flat RSS series across varying
 * session counts is exactly what a stuck/dead sampler (or a fixture bug)
 * produces, not an excellent fit - the pre-fix behavior silently reported
 * `rSquared: 1` (a zero-width CI, slope 0), which would make a downstream
 * `rSquared > 0.9` gate (e.g. the ramp integration test) ACCEPT a dead
 * sampler as a perfect measurement. Sibling of `DegenerateRampPointsError`
 * (that one guards zero x-variance; this one guards zero y-variance).
 */
export class DegenerateResponseError extends Error {
  constructor() {
    super(
      'fitRssRegression: all ramp points have the identical "rssMb" value - a flat response is indistinguishable from a stuck/dead sampler, not a perfect fit (R² is undefined here, never silently reported as 1)',
    );
    this.name = 'DegenerateResponseError';
  }
}

export interface RampPoint {
  /** Number of concurrent sessions the sample was measured at. */
  readonly sessions: number;
  /** Measured resident set size, in megabytes, at that session count. */
  readonly rssMb: number;
}

export interface ConfidenceInterval {
  readonly low: number;
  readonly high: number;
  readonly width: number;
}

export interface RssRegressionFit {
  /** Marginal MB per additional session (the fitted OLS slope). */
  readonly slopeMbPerSession: number;
  /** Fixed baseline MB at zero sessions (the fitted OLS intercept). */
  readonly interceptMb: number;
  /** Coefficient of determination in [0, 1] (1 = perfect linear fit). */
  readonly rSquared: number;
  /** 95% two-sided confidence interval on the slope. */
  readonly slopeCi95: ConfidenceInterval;
  readonly pointCount: number;
}

const MIN_RAMP_POINTS = 4;

/**
 * Fits `rssMb = interceptMb + slopeMbPerSession * sessions` by ordinary
 * least squares (delegated to the shared `fitLeastSquares` core). Throws
 * `TooFewRampPointsError` for fewer than 4 points and lets
 * `DegenerateRampPointsError` / `DegenerateResponseError` propagate unchanged
 * from `least-squares.ts` when every point shares the same `sessions` /
 * `rssMb` value respectively.
 */
export function fitRssRegression(points: readonly RampPoint[]): RssRegressionFit {
  const n = points.length;
  if (n < MIN_RAMP_POINTS) {
    throw new TooFewRampPointsError(n);
  }

  const xyPoints: readonly XyPoint[] = points.map((p) => ({ x: p.sessions, y: p.rssMb }));
  const fit = fitLeastSquares(xyPoints);

  return {
    slopeMbPerSession: fit.slope,
    interceptMb: fit.intercept,
    rSquared: fit.rSquared,
    slopeCi95: fit.slopeCi95,
    pointCount: fit.pointCount,
  };
}
