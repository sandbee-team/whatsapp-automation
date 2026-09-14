import { SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER, type HardwareFingerprint } from './artifact.js';

/**
 * scripts/measure/drift-run.ts (P26 Unit U3, step 3) - the 7-day drift-run
 * orchestrator (M6 + M13): a fixed session population `N` held resident for
 * the planned window, hourly artifact rows, NO forced GC anywhere (a leak
 * test must see production-like heap behaviour - forcing GC before every
 * sample would mask exactly the slow leak this run exists to detect). Pure
 * orchestration + artifact reader here; the real fleet wiring lives in
 * `app/backend/src/engine/measure/run-drift.ts`. The analysis
 * (checkpoint/verdict/format) functions live in the sibling
 * `drift-run-analysis.ts`, the artifact writer in `drift-run-writer.ts`, and
 * the CLI entry in `drift-run-cli.ts` (all split out to stay under the
 * 300-line cap - see `session-worker-discovery-wiring.ts` for the
 * established split idiom). Re-exported here so `import './drift-run.js'`
 * remains the one surface callers and tests need.
 */

export {
  driftSeriesFromSamples,
  checkpointReport,
  verdictReport,
  formatCheckpoint,
  formatVerdict,
  type DriftSeriesOptions,
  type CheckpointReport,
  type VerdictReport,
} from './drift-run-analysis.js';
export { createDriftArtifactWriter, type DriftArtifactWriter } from './drift-run-writer.js';

export const DRIFT_BANNER =
  `${SOCKET_RESIDENT_PRE_HANDSHAKE_BANNER} · DRIFT (M6): fixed N held resident for the ` +
  'planned window, hourly samples, no forced GC (production-like), real-number cohort = 0 ' +
  '(founder open item 6) - the verdict is computed by driftVerdict over rows with full residency ' +
  'only; P26a reads this file.';

export interface DriftRunHeader {
  kind: 'header';
  schemaVersion: 1;
  runKind: 'drift';
  /** Launch time - injected, never `new Date().toISOString()` inside this module. */
  capturedAtIso: string;
  profile: string;
  sessions: number;
  plannedHours: number;
  sampleIntervalMs: number;
  hardware: HardwareFingerprint;
  node: string;
  baileysVersion: string;
  banner: string;
  isLinux: boolean;
  realNumberCohort: 0;
  forcedGc: false;
  notes: string[];
}

export interface DriftSampleRow {
  kind: 'sample';
  ts: number;
  hourIndex: number;
  sessions: number;
  resident: number;
  /** `resident !== sessions` - recorded, never thrown (a 7-day run must survive and report). */
  degraded: boolean;
  rssBytes: number;
  cgroupCurrent: number | null;
  heapUsed: number;
  heapTotal: number;
  external: number;
  lagP50: number;
  lagP99: number;
  gcPauseP99Ms: number | null;
  gcCount: number | null;
  cpuPct: number | null;
  redisSigBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

export interface DriftMarkRow {
  kind: 'mark';
  ts: number;
  note: string;
}

export type DriftArtifactRow = DriftRunHeader | DriftSampleRow | DriftMarkRow;

const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------
// Artifact reader - tolerant line-by-line JSON parse.
// ---------------------------------------------------------------------

export interface ReadDriftArtifactResult {
  header: DriftRunHeader | null;
  samples: DriftSampleRow[];
  marks: DriftMarkRow[];
  malformedLines: number;
}

/** Tolerant line-by-line JSONL parse: a run still appending may leave a partial last line - skipped and counted, never thrown. */
export function readDriftArtifact(text: string): ReadDriftArtifactResult {
  const result: ReadDriftArtifactResult = {
    header: null,
    samples: [],
    marks: [],
    malformedLines: 0,
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      result.malformedLines += 1;
      continue;
    }

    const row = parsed as { kind?: string };
    if (row.kind === 'header') {
      result.header = parsed as DriftRunHeader;
    } else if (row.kind === 'sample') {
      result.samples.push(parsed as DriftSampleRow);
    } else if (row.kind === 'mark') {
      result.marks.push(parsed as DriftMarkRow);
    } else {
      result.malformedLines += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------
// Pure orchestration loop.
// ---------------------------------------------------------------------

export interface DriftFleet {
  addSessions(n: number): Promise<void>;
  sessionCount(): number;
  residentCount(): number;
}

export interface DriftSampler {
  sampleOnce(): Promise<{
    ts: number;
    sessions: number;
    rssBytes: number;
    cgroupCurrent: number | null;
    heapUsed: number;
    heapTotal: number;
    external: number;
    lagP50: number;
    lagP99: number;
    cpuPct: number | null;
    batchAddMsP50: number | null;
    batchAddMsP99: number | null;
    redisSigBytes: number | null;
    pgWriteRowsPerSec: number | null;
  }>;
}

export interface DriftArtifactRowWriter {
  writeRow(row: DriftArtifactRow): void;
}

export interface RunDriftSoakOptions {
  fleet: DriftFleet;
  sampler: DriftSampler;
  readGc: () => { pauseP99Ms: number | null; count: number | null };
  readNet: () => { rx: number | null; tx: number | null };
  sleep(ms: number): Promise<void>;
  now(): number;
  writer: DriftArtifactRowWriter;
  sessions: number;
  plannedHours: number;
  sampleIntervalMs: number;
  settleMs: number;
  onSample?: (row: DriftSampleRow) => void;
  stopSignal?: { stopped: boolean };
}

export interface RunDriftSoakResult {
  rowsWritten: number;
  degradedRows: number;
}

/**
 * Adds `sessions`, settles, then loops one hourly-cadence sample per tick
 * until `plannedHours` worth of samples are written (or `stopSignal.stopped`
 * fires early). A resident-population mismatch is RECORDED as `degraded`,
 * never thrown - a 7-day run must survive and report degradation, and P26a
 * excludes degraded rows from the verdict series. NO forced GC anywhere.
 */
export async function runDriftSoak(options: RunDriftSoakOptions): Promise<RunDriftSoakResult> {
  const { fleet, sampler, readGc, readNet, sleep, now, writer, sessions, sampleIntervalMs } =
    options;

  await fleet.addSessions(sessions);
  if (options.settleMs > 0) {
    await sleep(options.settleMs);
  }

  const plannedMs = options.plannedHours * HOUR_MS;
  const totalSamples = Math.ceil(plannedMs / sampleIntervalMs);

  let rowsWritten = 0;
  let degradedRows = 0;

  for (let hourIndex = 0; hourIndex < totalSamples; hourIndex += 1) {
    if (options.stopSignal?.stopped) break;

    const tickStart = now();
    const sample = await sampler.sampleOnce();
    const resident = fleet.residentCount();
    const degraded = resident !== sessions;
    const gc = readGc();
    const net = readNet();

    const row: DriftSampleRow = {
      kind: 'sample',
      ts: sample.ts,
      hourIndex,
      sessions,
      resident,
      degraded,
      rssBytes: sample.rssBytes,
      cgroupCurrent: sample.cgroupCurrent,
      heapUsed: sample.heapUsed,
      heapTotal: sample.heapTotal,
      external: sample.external,
      lagP50: sample.lagP50,
      lagP99: sample.lagP99,
      gcPauseP99Ms: gc.pauseP99Ms,
      gcCount: gc.count,
      cpuPct: sample.cpuPct,
      redisSigBytes: sample.redisSigBytes,
      netRxBytes: net.rx,
      netTxBytes: net.tx,
    };

    writer.writeRow(row);
    options.onSample?.(row);
    rowsWritten += 1;
    if (degraded) degradedRows += 1;

    const elapsed = now() - tickStart;
    const remaining = Math.max(0, sampleIntervalMs - elapsed);
    await sleep(remaining);
  }

  return { rowsWritten, degradedRows };
}

// The artifact writer (`createDriftArtifactWriter`) lives in the sibling
// `drift-run-writer.ts` module, re-exported above. CLI modes
// (`--checkpoint`/`--verdict`/`--mark`) live in `drift-run-cli.ts`.
