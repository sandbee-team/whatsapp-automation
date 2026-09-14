import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  fitRssRegression,
  TooFewRampPointsError,
  trimmedMean,
  type RssRegressionFit,
} from '@wp/domain';
import {
  createSampler,
  createCpuPctReader,
  readCgroupCurrentBytesReal,
  type SampleRow,
  type PgQueryClientLike,
  type RedisInfoClientLike,
} from './sampler.js';
import {
  createArtifactWriter,
  SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER,
  type HardwareFingerprint,
  type SummaryRow,
} from './artifact.js';

/**
 * scripts/measure/ramp-sessions.ts (P10 Unit U3, step 3) - the ramp
 * orchestrator. A runnable script (`main()`, invoked when this module is the
 * process entry point) AND an exported `runRamp(deps)` the integration test
 * drives directly against a tiny 5/10/15/20 mini-ramp with sub-second
 * windows. The real run (50/250/1,000/2,000 per-box, 60/135/200/250
 * per-worker, 5-min settle, 20-min soak) is a PARAMETER, not a hardcoded
 * constant - see `DEFAULT_RAMP_POINTS`/`DEFAULT_SETTLE_MS`/`DEFAULT_SOAK_MS`
 * below, all overridable via `RunRampOptions`.
 */

export class DegradedRampPointError extends Error {
  constructor(sessions: number, resident: number) {
    super(
      `runRamp: ramp point at ${sessions} sessions degraded to ${resident} resident - VOID per ADR 0032 (never silently thinned)`,
    );
    this.name = 'DegradedRampPointError';
  }
}

/** Minimal fleet surface this orchestrator needs (structurally matches `MeasureFleet`). */
export interface RampFleet {
  addSessions(n: number): Promise<void>;
  sessionCount(): number;
  residentCount(): number;
  forceGc(): void;
}

/**
 * A plain sorted-array percentile tracker fed one BATCH-BUILD duration per
 * ramp point (WARNING 5, FIX-P10-A: renamed from `ConnectLatencyTracker` -
 * `record()` is called exactly once per ramp point, covering the whole
 * sequential `addSessions(delta)` loop's wall-clock duration, NOT a
 * per-socket connect latency - see the call site below and
 * `SampleRow.batchAddMsP50`'s doc comment in `sampler.ts`).
 */
export interface BatchAddMsTracker {
  record(ms: number): void;
  percentile(p: number): number | null;
}

export function createBatchAddMsTracker(): BatchAddMsTracker {
  const samples: number[] = [];
  return {
    record(ms: number): void {
      samples.push(ms);
    },
    percentile(p: number): number | null {
      if (samples.length === 0) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
      return sorted[Math.max(0, idx)] as number;
    },
  };
}

function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

export interface RunRampOptions {
  fleet: RampFleet;
  /** A `pg`-shaped pool/client - structurally typed so this module never depends on the `pg` package's own types (scripts/ has no direct `pg` dependency; see sampler.ts's identical `PgQueryClientLike`). */
  pool: PgQueryClientLike;
  /** An `ioredis`-shaped client - same structural-typing rationale as `pool` above. */
  redisSig: RedisInfoClientLike;
  /** Ramp points in ascending session-count order. Real run: 50/250/1000/2000 per-box or 60/135/200/250 per-worker. Test run: a tiny mini-ramp. */
  rampPoints: number[];
  /** Full planned ramp before any truncation (defaults to `rampPoints` when nothing was truncated). */
  plannedRampPoints?: number[];
  /** Settle window after `addSessions`+`forceGc`, before sampling starts. Real run: 5 minutes. Test run: a few ms. */
  settleMs: number;
  /** Soak window over which repeated samples are taken and trimmed-averaged into the summary row. Real run: 20 minutes. Test run: well under a second. */
  soakMs: number;
  /** Interval between samples within the soak window. */
  sampleIntervalMs: number;
  artifactPath: string;
  profile: string;
  /** Injected clock string - never `new Date().toISOString()` called inside this module's logic. */
  capturedAtIso: string;
  isLinux: boolean;
  hardware: HardwareFingerprint;
  node: string;
  baileysVersion: string;
  /**
   * RSS reader, defaulting to the real `process.memoryUsage().rss` (what every
   * real run uses). Injectable ONLY so a pure unit test can express a
   * realistic ramp: with 0 ms settle/soak windows the live process RSS barely
   * moves between points, which produces a FLAT response series and now
   * (correctly) throws `DegenerateResponseError` - a flat series is
   * indistinguishable from a stuck sampler, so `fitRssRegression` refuses it
   * rather than reporting R²=1. A test that wants to exercise the healthy
   * path must therefore supply RSS that actually grows with sessions.
   */
  readRssBytes?: () => number;
}

export interface RunRampResult {
  summaries: SummaryRow[];
  fit: RssRegressionFit | null;
}

/**
 * Runs the ramp: for each point, adds sessions, forces GC, settles, then
 * samples repeatedly over the soak window - asserting `residentCount() ===
 * sessions` before accepting the point (a degraded population throws
 * `DegradedRampPointError`, never silently thinning the ramp). Emits one
 * sample row per tick and one summary row per point; once >= 4 summary
 * points exist, fits an RSS regression and writes it into the artifact.
 */
export async function runRamp(options: RunRampOptions): Promise<RunRampResult> {
  const {
    fleet,
    pool,
    redisSig,
    rampPoints,
    settleMs,
    soakMs,
    sampleIntervalMs,
    artifactPath,
    profile,
    capturedAtIso,
    isLinux,
    hardware,
    node,
    baileysVersion,
  } = options;
  const plannedRampPoints = options.plannedRampPoints ?? rampPoints;
  const truncatedRampPoints = plannedRampPoints.filter((p) => !rampPoints.includes(p));

  const writer = createArtifactWriter(artifactPath, {
    schemaVersion: 1,
    capturedAtIso,
    profile,
    rampPoints,
    plannedRampPoints,
    truncatedRampPoints,
    hardware,
    node,
    baileysVersion,
    banner: SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER,
    isLinux,
  });

  const batchAddMs = createBatchAddMsTracker();
  const eventLoopDelayHistogram = monitorEventLoopDelay();
  eventLoopDelayHistogram.enable();

  const cpuPctReader = isLinux ? createCpuPctReader() : () => null;

  const sampler = createSampler({
    now: () => Date.now(),
    getSessions: () => fleet.sessionCount(),
    readRssBytes: options.readRssBytes ?? (() => process.memoryUsage().rss),
    readCgroupCurrentBytes: isLinux ? readCgroupCurrentBytesReal : () => null,
    readHeapStats: () => {
      const mem = process.memoryUsage();
      return { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external };
    },
    eventLoopDelayHistogram: {
      percentile: (p: number) => eventLoopDelayHistogram.percentile(p) / 1e6, // ns -> ms
    },
    readCpuPct: cpuPctReader,
    batchAddMs,
    redisSig,
    pg: pool,
    isLinux,
  });

  const summaries: SummaryRow[] = [];

  for (const targetSessions of rampPoints) {
    const before = fleet.sessionCount();
    const delta = targetSessions - before;
    // One sample per ramp point, covering the WHOLE sequential
    // `addSessions(delta)` batch-build loop below - a cumulative
    // batch-build duration, not a per-socket connect latency (WARNING 5,
    // FIX-P10-A).
    const batchAddStartedAt = Date.now();
    if (delta > 0) {
      await fleet.addSessions(delta);
    }
    batchAddMs.record(Date.now() - batchAddStartedAt);

    fleet.forceGc();
    await sleep(settleMs);

    if (fleet.residentCount() !== fleet.sessionCount()) {
      throw new DegradedRampPointError(fleet.sessionCount(), fleet.residentCount());
    }

    const rows: SampleRow[] = [];
    const soakStart = Date.now();
    while (Date.now() - soakStart < soakMs) {
      const row = await sampler.sampleOnce();
      rows.push(row);
      writer.writeSampleRow(row);
      await sleep(sampleIntervalMs);
    }
    // Always take at least one sample, even if soakMs is smaller than one
    // sampleIntervalMs tick (keeps very tiny test windows meaningful).
    if (rows.length === 0) {
      const row = await sampler.sampleOnce();
      rows.push(row);
      writer.writeSampleRow(row);
    }

    if (fleet.residentCount() !== fleet.sessionCount()) {
      throw new DegradedRampPointError(fleet.sessionCount(), fleet.residentCount());
    }

    const rssValues = rows.map((r) => r.rssBytes);
    const lagP99Values = rows.map((r) => r.lagP99);
    const cpuValues = rows.map((r) => r.cpuPct).filter((v): v is number => v !== null);
    const batchAddValues = rows.map((r) => r.batchAddMsP99).filter((v): v is number => v !== null);
    const redisValues = rows.map((r) => r.redisSigBytes).filter((v): v is number => v !== null);
    const pgValues = rows.map((r) => r.pgWriteRowsPerSec).filter((v): v is number => v !== null);

    const summary: SummaryRow = {
      sessions: fleet.sessionCount(),
      rssBytes: trimmedMean(rssValues),
      lagP99: percentileOf(lagP99Values, 99),
      cpuPct: cpuValues.length > 0 ? trimmedMean(cpuValues) : null,
      batchAddMs: batchAddValues.length > 0 ? percentileOf(batchAddValues, 99) : null,
      redisSigBytes: redisValues.length > 0 ? trimmedMean(redisValues) : null,
      pgWriteRowsPerSec: pgValues.length > 0 ? trimmedMean(pgValues) : null,
    };
    summaries.push(summary);
    writer.writeSummaryRow(summary);
  }

  let fit: RssRegressionFit | null = null;
  try {
    fit = fitRssRegression(
      summaries.map((s) => ({ sessions: s.sessions, rssMb: s.rssBytes / (1024 * 1024) })),
    );
  } catch (err) {
    if (!(err instanceof TooFewRampPointsError)) {
      throw err;
    }
    // Fewer than 4 points: leave `fit` null rather than fabricate one.
  }

  writer.finalizeArtifact(fit ?? undefined);

  return { summaries, fit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------
// Runnable-script entry point (real run) - only executes when this module
// is the process entry point, never on plain import (so the integration
// test importing `runRamp` never triggers a real ramp).
// ---------------------------------------------------------------------

const DEFAULT_RAMP_POINTS = [50, 250, 1000, 2000];
const DEFAULT_SETTLE_MS = 5 * 60 * 1000;
const DEFAULT_SOAK_MS = 20 * 60 * 1000;
const DEFAULT_SAMPLE_INTERVAL_MS = 5000;

void DEFAULT_RAMP_POINTS;
void DEFAULT_SETTLE_MS;
void DEFAULT_SOAK_MS;
void DEFAULT_SAMPLE_INTERVAL_MS;

/**
 * The real run (U4, main session, outside this repo's CI) wires its own
 * `main()` with real handles/hardware fingerprint and calls `runRamp`
 * directly - this module intentionally does NOT auto-run a real ramp on
 * import (every default above is documentation of the real run's shape,
 * consumed by the U4 session, not executed here).
 */
