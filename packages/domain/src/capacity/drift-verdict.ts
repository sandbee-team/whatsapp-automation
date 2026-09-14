/**
 * Slow-leak drift verdict over a series of hourly RSS samples (P26 Unit U1,
 * step 1). Fits `rssMib = intercept + slopeMbPerDay * days` by ordinary
 * least squares (the shared `fitLeastSquares` core, same engine as
 * `rss-regression.ts`'s ramp fit) and turns the fitted 95% confidence
 * interval on the slope into an explicit three-way verdict - `no-drift`,
 * `drift`, or `insufficient-data` - never a bare boolean, since "no drift
 * detected" and "not enough data to tell" are different claims a caller
 * (capacity review, alerting) must not conflate.
 *
 * `drift` iff the 95% CI on the slope lies entirely above zero (the leak is
 * statistically distinguishable from noise at this confidence level).
 * `no-drift` when the CI straddles zero OR the whole CI is negative -
 * shrinking RSS is not a leak. `insufficient-data` when there are too few
 * samples, too short a span, or too little hourly coverage to trust a fit at
 * all - it carries no slope/CI fields, only a human `reason`.
 *
 * A perfectly flat series (zero y-variance) is NOT reported as `no-drift`:
 * `fitLeastSquares` throws `DegenerateResponseError` for that case and this
 * module lets it propagate unchanged - a dead/stuck sampler must never be
 * mistaken for a measurement of stability (see that error's own doc in
 * `rss-regression.ts`).
 *
 * Pure and deterministic: no I/O, no Date.now(), no RNG, no Node builtins.
 */
import { fitLeastSquares } from './least-squares.js';
import type { XyPoint } from './least-squares.js';
import type { ConfidenceInterval } from './rss-regression.js';

export interface DriftSample {
  readonly tsMs: number;
  readonly rssBytes: number;
}

export interface DriftVerdictOptions {
  /** Minimum span, in days, the series must cover. Default 6. */
  readonly minSpanDays?: number;
  /**
   * Minimum fraction of hourly coverage required over the observed span.
   * Default 0.9 (required sampleCount >= ceil(minHourlyCoverage * spanDays *
   * 24)).
   */
  readonly minHourlyCoverage?: number;
}

interface DriftVerdictFields {
  readonly slopeMbPerDay: number;
  readonly slopeCi95: ConfidenceInterval;
  readonly rSquared: number;
  readonly spanDays: number;
  readonly sampleCount: number;
}

export type DriftVerdict =
  | ({ readonly kind: 'no-drift' } & DriftVerdictFields)
  | ({ readonly kind: 'drift' } & DriftVerdictFields)
  | {
      readonly kind: 'insufficient-data';
      readonly spanDays: number;
      readonly sampleCount: number;
      readonly reason: string;
    };

const DEFAULT_MIN_SPAN_DAYS = 6;
const DEFAULT_MIN_HOURLY_COVERAGE = 0.9;
const MIN_SAMPLES = 4;
const BYTES_PER_MIB = 1024 * 1024;
const MS_PER_DAY = 86_400_000;
const HOURS_PER_DAY = 24;

export function driftVerdict(
  series: readonly DriftSample[],
  options?: DriftVerdictOptions,
): DriftVerdict {
  const minSpanDays = options?.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS;
  const minHourlyCoverage = options?.minHourlyCoverage ?? DEFAULT_MIN_HOURLY_COVERAGE;

  const sorted = [...series].sort((a, b) => a.tsMs - b.tsMs);
  const sampleCount = sorted.length;

  if (sampleCount < MIN_SAMPLES) {
    return {
      kind: 'insufficient-data',
      spanDays: 0,
      sampleCount,
      reason: `need >= ${MIN_SAMPLES} samples, got ${sampleCount}`,
    };
  }

  const firstTs = sorted[0]!.tsMs;
  const lastTs = sorted[sampleCount - 1]!.tsMs;
  const spanDays = (lastTs - firstTs) / MS_PER_DAY;

  if (spanDays < minSpanDays) {
    return {
      kind: 'insufficient-data',
      spanDays,
      sampleCount,
      reason: `span ${spanDays.toFixed(2)} days is below the required minimum of ${minSpanDays} days`,
    };
  }

  const requiredSampleCount = Math.ceil(minHourlyCoverage * spanDays * HOURS_PER_DAY);
  if (sampleCount < requiredSampleCount) {
    return {
      kind: 'insufficient-data',
      spanDays,
      sampleCount,
      reason: `hourly coverage ${sampleCount}/${requiredSampleCount} is below the required ${(minHourlyCoverage * 100).toFixed(0)}% coverage over ${spanDays.toFixed(2)} days`,
    };
  }

  const points: readonly XyPoint[] = sorted.map((sample) => ({
    x: (sample.tsMs - firstTs) / MS_PER_DAY,
    y: sample.rssBytes / BYTES_PER_MIB,
  }));

  const fit = fitLeastSquares(points);
  const fields: DriftVerdictFields = {
    slopeMbPerDay: fit.slope,
    slopeCi95: fit.slopeCi95,
    rSquared: fit.rSquared,
    spanDays,
    sampleCount,
  };

  return fit.slopeCi95.low > 0 ? { kind: 'drift', ...fields } : { kind: 'no-drift', ...fields };
}
