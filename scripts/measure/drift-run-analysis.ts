import { fitLeastSquares, driftVerdict, type DriftVerdict, type DriftSample } from '@wp/domain';
import type { DriftSampleRow } from './drift-run.js';

/**
 * scripts/measure/drift-run-analysis.ts (P26 Unit U3, step 3) - the
 * checkpoint/verdict analysis + formatting functions, split out of
 * `drift-run.ts` to stay under the 300-line cap (the established split
 * idiom - see `session-worker-discovery-wiring.ts`).
 */

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;
const MS_PER_DAY = 24 * HOUR_MS;

export interface DriftSeriesOptions {
  /** Default true - excludes rows with `degraded === true`. */
  requireFullResidency?: boolean;
}

export function driftSeriesFromSamples(
  samples: readonly DriftSampleRow[],
  opts?: DriftSeriesOptions,
): { series: DriftSample[]; excludedDegraded: number } {
  const requireFullResidency = opts?.requireFullResidency ?? true;
  let excludedDegraded = 0;
  const series: DriftSample[] = [];

  for (const row of samples) {
    if (requireFullResidency && row.degraded) {
      excludedDegraded += 1;
      continue;
    }
    series.push({ tsMs: row.ts, rssBytes: row.rssBytes });
  }

  return { series, excludedDegraded };
}

export interface CheckpointReport {
  rowsSeen: number;
  excludedDegraded: number;
  spanDays: number;
  slopeMbPerDayOrNull: number | null;
  ci95OrNull: { low: number; high: number } | null;
  note: string;
}

const MIN_CHECKPOINT_ROWS = 4;

/** A progress print over the rows seen SO FAR - never a verdict (too few days to trust one). */
export function checkpointReport(samples: readonly DriftSampleRow[]): CheckpointReport {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const { series, excludedDegraded } = driftSeriesFromSamples(sorted);

  if (series.length < MIN_CHECKPOINT_ROWS) {
    return {
      rowsSeen: samples.length,
      excludedDegraded,
      spanDays: 0,
      slopeMbPerDayOrNull: null,
      ci95OrNull: null,
      note: `checkpoint: fewer than ${String(MIN_CHECKPOINT_ROWS)} usable rows so far, no slope yet`,
    };
  }

  const firstTs = series[0]!.tsMs;
  const lastTs = series[series.length - 1]!.tsMs;
  const spanDays = (lastTs - firstTs) / MS_PER_DAY;

  const fit = fitLeastSquares(
    series.map((s) => ({ x: (s.tsMs - firstTs) / MS_PER_DAY, y: s.rssBytes / MIB })),
  );

  return {
    rowsSeen: samples.length,
    excludedDegraded,
    spanDays,
    slopeMbPerDayOrNull: fit.slope,
    ci95OrNull: { low: fit.slopeCi95.low, high: fit.slopeCi95.high },
    note: `checkpoint: slope over ${String(series.length)} usable rows spanning ${spanDays.toFixed(2)} days`,
  };
}

export interface VerdictReport {
  excludedDegraded: number;
  marksNote: string;
}

export function verdictReport(
  samples: readonly DriftSampleRow[],
  opts?: DriftSeriesOptions,
): VerdictReport & DriftVerdict {
  const { series, excludedDegraded } = driftSeriesFromSamples(samples, opts);
  const verdict = driftVerdict(series);
  return {
    ...verdict,
    excludedDegraded,
    marksNote: 'marks (if any) are informational annotations only - never excluded rows',
  };
}

export function formatCheckpoint(report: CheckpointReport): string {
  const lines = [
    'checkpoint:',
    `  rows seen: ${String(report.rowsSeen)} (excluded degraded: ${String(report.excludedDegraded)})`,
    `  span: ${report.spanDays.toFixed(3)} days`,
  ];
  if (report.slopeMbPerDayOrNull === null) {
    lines.push('  slope: not enough usable rows yet');
  } else {
    lines.push(
      `  slope: ${report.slopeMbPerDayOrNull.toFixed(4)} MB/day (95% CI [${report.ci95OrNull!.low.toFixed(4)}, ${report.ci95OrNull!.high.toFixed(4)}])`,
    );
  }
  lines.push(`  ${report.note}`);
  return lines.join('\n');
}

export function formatVerdict(report: VerdictReport & DriftVerdict): string {
  const lines = [`verdict: ${report.kind}`, `  span: ${report.spanDays.toFixed(3)} days`];
  if (report.kind === 'insufficient-data') {
    lines.push(`  sample count: ${String(report.sampleCount)}`);
    lines.push(`  reason: ${report.reason}`);
  } else {
    lines.push(`  sample count: ${String(report.sampleCount)}`);
    lines.push(
      `  slope: ${report.slopeMbPerDay.toFixed(4)} MB/day (95% CI [${report.slopeCi95.low.toFixed(4)}, ${report.slopeCi95.high.toFixed(4)}]), R²=${report.rSquared.toFixed(4)}`,
    );
  }
  lines.push(`  excluded degraded rows: ${String(report.excludedDegraded)}`);
  lines.push(`  ${report.marksNote}`);
  return lines.join('\n');
}
