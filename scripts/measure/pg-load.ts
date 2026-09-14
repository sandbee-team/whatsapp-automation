import {
  loadModel,
  projectDailyGrowth,
  UnpublishableLoadModelError,
  InvalidLoadModelWindowError,
  InvalidConnectedCountError,
  type LoadModel,
  type DailyGrowthProjection,
} from '@wp/domain';
import type { HardwareFingerprint } from './artifact.js';

/**
 * scripts/measure/pg-load.ts (P26 U4, step 4: M8+M9 measured load model) -
 * PURE half of the pg_stat_statements/relation-size/WAL measurement:
 * snapshot delta arithmetic, the `PgLoadArtifact` schema + validator, and
 * the summary formatter. No `pg`, no `app/backend` - only `@wp/domain` (for
 * `loadModel`/`projectDailyGrowth`, the one place per-send ratios are
 * computed) and `node:fs` for `--verify`. The runnable harness that takes
 * REAL snapshots lives in `app/backend/src/engine/measure/run-pg-load.ts`
 * (same split as `send-load-driver.ts`/`send-load-driver-run.ts`).
 *
 * ADR 0018 section 7's fixed figures this measurement REPLACES may appear
 * ONLY inside the `derivedComparison` object literal below - the one place
 * that names them as "the thing being compared against".
 * `pg-load-validate.test.ts`'s `derived_literals_never_leak_outside_derived_comparison`
 * strips comments then scans for those figures outside that block (same
 * discipline as `load-model.ts`'s header) - possible here because
 * `scripts/**` is exempt from the depcruise src-isolation rules.
 *
 * The validator, summary formatter and `--verify` CLI live in the sibling
 * `pg-load-validate.ts` (300-line cap split, established idiom -
 * `session-worker-discovery-wiring.ts`).
 */

export interface PgBouncerSnapshot {
  poolMode: string;
  defaultPoolSize: number | null;
  maxClientConn: number | null;
  clWaiting: number | null;
  avgWaitUs: number | null;
}

export interface PgSnapshot {
  atMs: number;
  statementsTotal: number;
  relationSizesBytes: Record<string, number>;
  walBytes: number;
  pgBouncer: PgBouncerSnapshot | null;
  pacingConsumed: number;
}

/**
 * Idle-baseline RATES sampled over a window BEFORE the drive starts, while
 * the fleet is up but not yet sending - see `run-pg-load.ts`'s own header
 * for why this exists (MAJOR 5: the drift fleet, `wp-p26-drift`, shares this
 * Postgres, so a raw drive-window delta also counts whatever that second
 * fleet did during the same wall-clock window).
 */
export interface PgLoadBaseline {
  statementsPerSec: number;
  walBytesPerSec: number;
  relationBytesPerSec: number;
  /** How long the baseline was sampled for - never assumed, always the actual idle window length. */
  seconds: number;
}

export interface PgLoadArtifact {
  schemaVersion: 1;
  kind: 'load-model';
  capturedAtIso: string;
  hardware: HardwareFingerprint;
  node: string;
  viaPgBouncer: boolean;
  window: { startMs: number; endMs: number; seconds: number };
  sends: { attempted: number; observed: number };
  deltas: {
    statements: number;
    relationSizeBytes: number;
    walBytes: number;
    perTableBytes: Record<string, number>;
    /** Raw drive-window deltas above, minus the idle-baseline's own share of the SAME window length. `null` only when `baseline` is also `null` (see that field's own doc). */
    baselineSubtracted: { statements: number; relationSizeBytes: number; walBytes: number } | null;
  };
  /** The idle-baseline sample this run took, or `null` when `--baseline-seconds 0` was explicitly passed (a `notes` entry naming that is then required - see `validatePgLoadArtifact`). */
  baseline: PgLoadBaseline | null;
  /** What else was running on this box during the measurement, from `--concurrent-note` - defaults to `'none declared'`, never silently assumed idle. */
  concurrentNote: string;
  /** `message_jobs.status` -> row count for the probe clients at artifact-build time - lets a reader see `processing`/`needs_reconcile` residue the harness's own tallies would hide (P26 C1 Harness gap). */
  jobStatusHistogram: Record<string, number>;
  /** FIX-P26-E: whether `waitForDrain` completed before its timeout. `complete: false` means this artifact is evidence of a FAILED run, never a publishable load model - `validatePgLoadArtifact` enforces that. */
  drain: {
    complete: boolean;
    pendingAtEnd: number;
    pendingSample: { id: string; status: string; attempts: number }[];
  };
  measured: {
    statementsPerSend: number;
    bytesPerSend: number;
    walMbPerSec: number;
    sendsPerSecond: number;
    sampleSize: { sendCount: number; windowSeconds: number };
  };
  projected: {
    connected: number;
    sendsPerDayPerInstance: number;
    bytesPerDay: number;
    gbPerDay: number;
  }[];
  derivedComparison: {
    statementsPerSendDerived: 12;
    bytesPerSendDerived: 3276.8;
    sendsPerDayDerived: 600;
    agreement: string;
  };
  notes: string[];
}

export interface SnapshotDelta {
  statements: number;
  relationSizeBytes: number;
  walBytes: number;
  perTableBytes: Record<string, number>;
  seconds: number;
  pacingConsumed: number;
}

/**
 * Diffs two snapshots. Per-table byte deltas (and the summed total) are
 * NEVER clamped to zero - autovacuum/HOT pruning can legitimately shrink a
 * table mid-window, and silently dropping or flooring a negative delta
 * would fabricate a measurement. A negative TOTAL is instead a named
 * problem surfaced by `validatePgLoadArtifact`, never hidden here.
 */
export function diffSnapshots(before: PgSnapshot, after: PgSnapshot): SnapshotDelta {
  const perTableBytes: Record<string, number> = {};
  const tableNames = new Set([
    ...Object.keys(before.relationSizesBytes),
    ...Object.keys(after.relationSizesBytes),
  ]);
  let relationSizeBytes = 0;
  for (const name of tableNames) {
    const delta = (after.relationSizesBytes[name] ?? 0) - (before.relationSizesBytes[name] ?? 0);
    perTableBytes[name] = delta;
    relationSizeBytes += delta;
  }

  return {
    statements: after.statementsTotal - before.statementsTotal,
    relationSizeBytes,
    walBytes: after.walBytes - before.walBytes,
    perTableBytes,
    seconds: (after.atMs - before.atMs) / 1000,
    pacingConsumed: after.pacingConsumed - before.pacingConsumed,
  };
}

export interface BuildPgLoadArtifactInput {
  capturedAtIso: string;
  hardware: HardwareFingerprint;
  node: string;
  viaPgBouncer: boolean;
  window: { startMs: number; endMs: number };
  sends: { attempted: number; observed: number };
  delta: SnapshotDelta;
  projectAt: { connected: number; sendsPerDayPerInstance: number }[];
  /** The idle baseline sampled BEFORE the drive, or `null` when `--baseline-seconds 0` was explicitly passed (that case REQUIRES a matching `notes` entry - `validatePgLoadArtifact` enforces it). */
  baseline: PgLoadBaseline | null;
  /** What else is running on this box during the measurement (`--concurrent-note`, default `'none declared'`). */
  concurrentNote: string;
  /** `message_jobs.status` -> count for the probe clients, read at artifact-build time. */
  jobStatusHistogram?: Record<string, number>;
  /** FIX-P26-E: pass `{ complete: true, pendingAtEnd: 0, pendingSample: [] }` for a completed drain. */
  drain: {
    complete: boolean;
    pendingAtEnd: number;
    pendingSample: PgLoadArtifact['drain']['pendingSample'];
  };
  notes?: string[];
}

/**
 * Subtracts the idle baseline's own share of the drive window (rate * drive
 * window seconds) from each raw delta - never clamped to zero, for the same
 * reason `diffSnapshots` never clamps a per-table delta (autovacuum/HOT
 * pruning can legitimately make a share exceed the raw delta on a short or
 * quiet drive window; a negative result is real information, not an error).
 */
function subtractBaselineShare(
  delta: SnapshotDelta,
  baseline: PgLoadBaseline,
): { statements: number; relationSizeBytes: number; walBytes: number } {
  return {
    statements: delta.statements - baseline.statementsPerSec * delta.seconds,
    relationSizeBytes: delta.relationSizeBytes - baseline.relationBytesPerSec * delta.seconds,
    walBytes: delta.walBytes - baseline.walBytesPerSec * delta.seconds,
  };
}

/**
 * Builds the artifact by calling `loadModel` + `projectDailyGrowth` (the one
 * place a byte/statement delta is converted into a per-send ratio) -
 * `sends.observed <= 0` throws `UnpublishableLoadModelError` straight
 * through, never caught and reinterpreted as a zero result.
 */
export function buildPgLoadArtifact(input: BuildPgLoadArtifactInput): PgLoadArtifact {
  const windowSeconds = (input.window.endMs - input.window.startMs) / 1000;

  const model: LoadModel = loadModel({
    sendCount: input.sends.observed,
    statementDelta: input.delta.statements,
    relationSizeDeltaBytes: input.delta.relationSizeBytes,
    walBytes: input.delta.walBytes,
    windowSeconds,
  });

  const projected: DailyGrowthProjection[] = input.projectAt.map((p) =>
    projectDailyGrowth(model, p),
  );

  const notes = [...(input.notes ?? [])];
  notes.push(`concurrent load during this run: ${input.concurrentNote}`);

  return {
    schemaVersion: 1,
    kind: 'load-model',
    capturedAtIso: input.capturedAtIso,
    hardware: input.hardware,
    node: input.node,
    viaPgBouncer: input.viaPgBouncer,
    window: {
      startMs: input.window.startMs,
      endMs: input.window.endMs,
      seconds: windowSeconds,
    },
    sends: input.sends,
    deltas: {
      statements: input.delta.statements,
      relationSizeBytes: input.delta.relationSizeBytes,
      walBytes: input.delta.walBytes,
      perTableBytes: input.delta.perTableBytes,
      baselineSubtracted:
        input.baseline === null ? null : subtractBaselineShare(input.delta, input.baseline),
    },
    baseline: input.baseline,
    concurrentNote: input.concurrentNote,
    jobStatusHistogram: input.jobStatusHistogram ?? {},
    drain: input.drain,
    measured: {
      statementsPerSend: model.statementsPerSend,
      bytesPerSend: model.bytesPerSend,
      walMbPerSec: model.walMbPerSec,
      sendsPerSecond: model.sendsPerSecond,
      sampleSize: model.sampleSize,
    },
    projected: projected.map((p) => ({
      connected: p.connected,
      sendsPerDayPerInstance: p.sendsPerDayPerInstance,
      bytesPerDay: p.bytesPerDay,
      gbPerDay: p.gbPerDay,
    })),
    derivedComparison: {
      statementsPerSendDerived: 12,
      bytesPerSendDerived: 3276.8,
      sendsPerDayDerived: 600,
      agreement: `measured ${model.statementsPerSend.toFixed(2)} statements/send vs ADR 0018 section 7's derived 12; measured ${model.bytesPerSend.toFixed(2)} bytes/send vs derived 3276.8`,
    },
    notes,
  };
}

export { UnpublishableLoadModelError, InvalidLoadModelWindowError, InvalidConnectedCountError };
