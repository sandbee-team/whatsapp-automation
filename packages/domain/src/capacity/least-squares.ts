/**
 * Canonical ordinary-least-squares (OLS) simple linear regression core
 * (P26 Unit U1, step 1) - extracted from `rss-regression.ts` so a second
 * caller (`drift-verdict.ts`, fitting MB/day slope over hourly RSS samples)
 * does not reinvent the same arithmetic and Student-t lookup table.
 *
 * Fits `y = intercept + slope * x` over `{x, y}` points, reporting R² and a
 * 95% two-sided confidence interval on the slope via the Student-t critical
 * value for `n - 2` degrees of freedom (falling back to the normal
 * approximation z = 1.96 above df 30 - no dependency on a stats library).
 *
 * Throws `DegenerateRampPointsError` when every point shares the same `x`
 * (slope undefined, zero x-variance) and `DegenerateResponseError` when every
 * point shares the same `y` (a flat response is indistinguishable from a
 * stuck/dead sampler, never silently reported as a perfect `rSquared: 1` -
 * see that error class's own doc in `rss-regression.ts`, its home module).
 * Callers needing >= N points enforce that threshold themselves before
 * calling in (this module has no minimum-point opinion of its own).
 *
 * Pure and deterministic: no I/O, no Date, no RNG, no Node builtins.
 */
import { DegenerateRampPointsError, DegenerateResponseError } from './rss-regression.js';
import type { ConfidenceInterval } from './rss-regression.js';

export interface XyPoint {
  readonly x: number;
  readonly y: number;
}

export interface LeastSquaresFit {
  readonly slope: number;
  readonly intercept: number;
  readonly rSquared: number;
  readonly slopeCi95: ConfidenceInterval;
  readonly pointCount: number;
}

/**
 * Two-sided 95% Student-t critical values for df 1..30 (t_{0.025, df}).
 * Above df 30 the distribution is close enough to normal that this module
 * falls back to the z = 1.96 normal-approximation critical value instead of
 * growing the table indefinitely.
 */
const T_TABLE_95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];
const NORMAL_APPROX_CRITICAL_VALUE = 1.96;

export function tCriticalValue(degreesOfFreedom: number): number {
  if (degreesOfFreedom >= 1 && degreesOfFreedom <= T_TABLE_95.length) {
    return T_TABLE_95[degreesOfFreedom - 1] as number;
  }
  return NORMAL_APPROX_CRITICAL_VALUE;
}

/**
 * Fits `y = intercept + slope * x` by ordinary least squares over `points`.
 * Requires at least 2 points with distinct `x` values (callers enforce any
 * higher minimum themselves). Throws `DegenerateRampPointsError` on zero
 * x-variance and `DegenerateResponseError` on zero y-variance.
 */
export function fitLeastSquares(points: readonly XyPoint[]): LeastSquaresFit {
  const n = points.length;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;

  let sumXx = 0;
  let sumXy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    sumXx += dx * dx;
    sumXy += dx * dy;
  }

  if (sumXx === 0) {
    throw new DegenerateRampPointsError();
  }

  const slope = sumXy / sumXx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const predicted = intercept + slope * (xs[i] as number);
    const residual = (ys[i] as number) - predicted;
    ssRes += residual * residual;
    const totalDev = (ys[i] as number) - meanY;
    ssTot += totalDev * totalDev;
  }

  if (ssTot === 0) {
    throw new DegenerateResponseError();
  }

  const rSquared = 1 - ssRes / ssTot;

  const degreesOfFreedom = n - 2;
  const residualVariance = ssRes / degreesOfFreedom;
  const slopeStdError = Math.sqrt(residualVariance / sumXx);
  const tCrit = tCriticalValue(degreesOfFreedom);
  const marginOfError = tCrit * slopeStdError;

  const slopeCi95: ConfidenceInterval = {
    low: slope - marginOfError,
    high: slope + marginOfError,
    width: 2 * marginOfError,
  };

  return { slope, intercept, rSquared, slopeCi95, pointCount: n };
}
