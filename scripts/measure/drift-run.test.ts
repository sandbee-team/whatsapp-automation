import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readDriftArtifact,
  driftSeriesFromSamples,
  checkpointReport,
  verdictReport,
  formatCheckpoint,
  formatVerdict,
  runDriftSoak,
  createDriftArtifactWriter,
  type DriftSampleRow,
  type DriftRunHeader,
} from './drift-run.js';
import { MissingHardwareFingerprintError } from './artifact.js';

/** drift-run.test.ts (P26 U3, step 3) - pure unit tests, fake clocks/sleep/fleet/sampler throughout. */

function baseHardware() {
  return {
    cpuModel: 'test-cpu',
    cpuCount: 4,
    totalMemBytes: 16_000_000_000,
    kernel: 'test-kernel',
    cgroupVersion: 2,
  };
}

function baseHeader(overrides: Partial<DriftRunHeader> = {}): DriftRunHeader {
  return {
    kind: 'header',
    schemaVersion: 1,
    runKind: 'drift',
    capturedAtIso: '2026-09-01T00:00:00.000Z',
    profile: 'idle',
    sessions: 1000,
    plannedHours: 168,
    sampleIntervalMs: 3_600_000,
    hardware: baseHardware(),
    node: 'v24.20.0',
    baileysVersion: '7.0.0-rc14',
    banner: 'DRIFT (M6) test banner',
    isLinux: true,
    realNumberCohort: 0,
    forcedGc: false,
    notes: [],
    ...overrides,
  };
}

function baseHeaderLine(overrides: Partial<DriftRunHeader> = {}): string {
  return JSON.stringify(baseHeader(overrides));
}

function sampleLine(row: Partial<DriftSampleRow> & { ts: number; hourIndex: number }): string {
  // `ts`/`hourIndex` come from the trailing `...row` spread (required on the
  // parameter type), so they are deliberately not repeated here - TS2783.
  const full: DriftSampleRow = {
    kind: 'sample',
    sessions: 1000,
    resident: 1000,
    degraded: false,
    rssBytes: 500 * 1024 * 1024,
    cgroupCurrent: null,
    heapUsed: 100,
    heapTotal: 200,
    external: 10,
    lagP50: 1,
    lagP99: 2,
    gcPauseP99Ms: null,
    gcCount: null,
    cpuPct: null,
    redisSigBytes: null,
    netRxBytes: null,
    netTxBytes: null,
    ...row,
  };
  return JSON.stringify(full);
}

const HOUR_MS = 3_600_000;
const MIB = 1024 * 1024;

describe('readDriftArtifact + driftSeriesFromSamples', () => {
  it('verdict_mode_reads_only_sample_rows_and_reports_the_span_it_actually_covers', () => {
    const lines: string[] = [baseHeaderLine()];
    const totalHours = 4 * 24;
    for (let h = 0; h < totalHours; h += 1) {
      lines.push(
        sampleLine({
          ts: h * HOUR_MS,
          hourIndex: h,
          rssBytes: (500 + h * 0.01) * MIB,
        }),
      );
    }
    lines.push(JSON.stringify({ kind: 'mark', ts: 10 * HOUR_MS, note: 'load run started' }));
    lines.push(JSON.stringify({ kind: 'mark', ts: 20 * HOUR_MS, note: 'load run ended' }));
    const text = `${lines.join('\n')}\n{"kind":"sample","ts":999,"hourIndex":999,truncated`;

    const parsed = readDriftArtifact(text);
    expect(parsed.samples).toHaveLength(96);
    expect(parsed.marks).toHaveLength(2);
    expect(parsed.malformedLines).toBe(1);
    expect(parsed.header).not.toBeNull();

    const report = verdictReport(parsed.samples);
    expect(report.kind).toBe('insufficient-data');
    if (report.kind === 'insufficient-data') {
      expect(report.spanDays).toBeCloseTo(3.958, 2);
      expect(report.reason).toContain('span');
    }

    const formatted = formatVerdict(report);
    expect(formatted).toContain('insufficient-data');
    expect(formatted).not.toContain('slope');
  });

  it('degraded_rows_are_excluded_from_the_series_and_counted', () => {
    const totalHours = 7 * 24;
    const samples: DriftSampleRow[] = [];
    for (let h = 0; h < totalHours; h += 1) {
      samples.push(
        JSON.parse(
          sampleLine({
            ts: h * HOUR_MS,
            hourIndex: h,
            degraded: h % 30 === 0 && h < 150, // 5 rows: h=0,30,60,90,120
            rssBytes: (500 + h * (2 / 24)) * MIB,
          }),
        ) as DriftSampleRow,
      );
    }
    const degradedCount = samples.filter((s) => s.degraded).length;
    expect(degradedCount).toBe(5);

    const { series, excludedDegraded } = driftSeriesFromSamples(samples);
    expect(series).toHaveLength(163);
    expect(excludedDegraded).toBe(5);
  });
});

describe('checkpointReport', () => {
  it('checkpoint_prints_the_slope_over_the_rows_seen_so_far_without_a_verdict', () => {
    const samples: DriftSampleRow[] = [];
    for (let h = 0; h < 30; h += 1) {
      const days = h / 24;
      samples.push(
        JSON.parse(
          sampleLine({
            ts: h * HOUR_MS,
            hourIndex: h,
            rssBytes: (500 + 2 * days) * MIB,
          }),
        ) as DriftSampleRow,
      );
    }

    const report = checkpointReport(samples);
    expect(report.rowsSeen).toBe(30);
    expect(report.slopeMbPerDayOrNull).not.toBeNull();
    expect(report.slopeMbPerDayOrNull as number).toBeCloseTo(2, 6);

    const formatted = formatCheckpoint(report);
    expect(formatted).toContain('checkpoint');
    expect(formatted).not.toContain('no-drift');
    expect(formatted).not.toContain('drift verdict');
  });
});

describe('verdictReport - full 7-day run', () => {
  it('a_seven_day_run_with_a_two_mb_per_day_slope_is_flagged_as_drift_by_the_verdict_mode', () => {
    const samples: DriftSampleRow[] = [];
    for (let h = 0; h < 168; h += 1) {
      const days = h / 24;
      // Deterministic small "noise": a bounded oscillation, never random.
      const noise = 0.05 * Math.sin(h);
      samples.push(
        JSON.parse(
          sampleLine({
            ts: h * HOUR_MS,
            hourIndex: h,
            rssBytes: (500 + 2 * days + noise) * MIB,
          }),
        ) as DriftSampleRow,
      );
    }

    const report = verdictReport(samples);
    expect(report.kind).toBe('drift');
    if (report.kind === 'drift') {
      expect(report.slopeMbPerDay).toBeCloseTo(2, 1);
    }

    const formatted = formatVerdict(report);
    expect(formatted).toContain('drift');
  });
});

describe('runDriftSoak', () => {
  it('run_drift_soak_records_degradation_instead_of_dying', async () => {
    // plannedHours=0.001h * 3_600_000 ms/h = 3.6ms planned window at a 1000ms
    // sample interval => ceil(3.6/1000) = 4 samples.
    const sessions = 10;
    let residentValue = sessions;
    let nowMs = 0;
    const sleepCalls: number[] = [];

    const fleet = {
      addSessions: async (): Promise<void> => {
        residentValue = sessions;
      },
      sessionCount: (): number => sessions,
      residentCount: (): number => residentValue,
    };

    let tick = 0;
    const sampler = {
      sampleOnce: async () => {
        tick += 1;
        nowMs += 100; // sampling itself costs 100ms of wall clock
        if (tick === 3 || tick === 4) {
          residentValue = sessions - 1;
        }
        return {
          ts: nowMs,
          sessions,
          rssBytes: 500 * MIB,
          cgroupCurrent: null,
          heapUsed: 1,
          heapTotal: 2,
          external: 0,
          lagP50: 1,
          lagP99: 2,
          cpuPct: null,
          batchAddMsP50: null,
          batchAddMsP99: null,
          redisSigBytes: null,
          pgWriteRowsPerSec: null,
        };
      },
    };

    const rows: DriftSampleRow[] = [];

    const result = await runDriftSoak({
      fleet,
      sampler,
      readGc: () => ({ pauseP99Ms: null, count: null }),
      readNet: () => ({ rx: null, tx: null }),
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        nowMs += ms;
      },
      now: () => nowMs,
      writer: {
        writeRow: (row) => {
          if (row.kind === 'sample') rows.push(row);
        },
      },
      sessions,
      plannedHours: 0.001,
      sampleIntervalMs: 1000,
      settleMs: 0,
    });

    expect(result.rowsWritten).toBe(4);
    expect(result.degradedRows).toBe(2);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.hourIndex)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.degraded)).toEqual([false, false, true, true]);
    expect(rows.every((r) => r.sessions === sessions)).toBe(true);
    expect(sleepCalls).toEqual([900, 900, 900, 900]);
  });
});

describe('createDriftArtifactWriter header validation', () => {
  it('header_without_a_fingerprint_is_refused_before_any_write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-drift-'));
    const outPath = join(dir, 'drift.jsonl');

    try {
      expect(() => createDriftArtifactWriter(outPath, baseHeader({ isLinux: false }))).toThrow(
        MissingHardwareFingerprintError,
      );
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
