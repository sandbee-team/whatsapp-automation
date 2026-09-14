import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { createPool } from '@wp/db';
import {
  buildPgLoadArtifact,
  diffSnapshots,
  type PgLoadBaseline,
  type PgSnapshot,
} from '../../../../../scripts/measure/pg-load.js';
import { validatePgLoadArtifact } from '../../../../../scripts/measure/pg-load-validate.js';
import type { SendLoadPlanItem } from './send-load-driver.js';
import type { CliArgs } from './run-pg-load-args.js';
import { readHardwareFingerprint } from './run-pg-load-args.js';
import { formatSweepCountsNote } from './run-pacing-windows.js';
import {
  readTerminalJobCount,
  readJobStatusHistogram,
  takeSnapshot,
} from './run-pg-load-snapshots.js';
import type { DrainTimeoutError } from './run-pg-load-fleet.js';

/**
 * run-pg-load-incomplete.ts (FIX-P26-E) - the partial-artifact path taken
 * when `waitForDrain` throws `DrainTimeoutError`, split out of
 * `run-pg-load.ts` for the 300-line cap (established idiom -
 * `session-worker-discovery-wiring.ts`). Evidence of a partial run must
 * still be written (Harness gap: the first real run stalled for its full
 * duration and produced NOTHING) - but it is written to a `.INCOMPLETE.json`
 * path so it can never be mistaken for a publishable artifact by path alone,
 * on top of `pg-load-validate.ts`'s `drain.complete === false` problem.
 */

type Sweeps = { counts: () => Parameters<typeof formatSweepCountsNote>[0] };

/** Everything `writePartialArtifactOnDrainTimeout` needs from the caller's already-open run - no new DB reads beyond what it takes itself (the AFTER snapshot + terminal counts). */
export interface PartialArtifactDeps {
  pool: ReturnType<typeof createPool>;
  pgBouncerAdminUrl: string | null;
  targetDatabase: string;
  instanceIds: string[];
  clientIds: string[];
  sweeps: Sweeps;
  notes: string[];
  before: PgSnapshot;
  sendPlan: SendLoadPlanItem[];
  perPlanItem: number;
  args: CliArgs;
  viaPgBouncer: boolean;
  projectedSendsPerDay: { value: number; source: string };
  baseline: PgLoadBaseline | null;
}

/**
 * Pure: replaces the configured `--out` extension with `.INCOMPLETE.json`.
 * BUG FIX (P26 C2): a `.replace(/\.json$/, ...)` with no match returns the
 * INPUT UNCHANGED - an operator-supplied `--out` with no `.json` suffix (or
 * a different case, e.g. `.JSON`) produced a partial artifact at the EXACT
 * SAME path a real publishable artifact would use, defeating the one
 * property this function exists to guarantee (see module doc: "so it can
 * never be mistaken for a publishable artifact by path alone"). Case-
 * insensitively strip a trailing `.json` if present, then ALWAYS append the
 * marker - the result is guaranteed to end in `.INCOMPLETE.json` for any
 * input, matched extension or not.
 */
export function toIncompleteOutPath(outPath: string): string {
  const withoutJsonExt = outPath.replace(/\.json$/i, '');
  return `${withoutJsonExt}.INCOMPLETE.json`;
}

/** Pure: formats the artifact `notes` entry recording the drain timeout. */
export function formatDrainTimeoutNote(err: DrainTimeoutError): string {
  return `drain timeout: ${(err.elapsedMs / 1000).toFixed(1)}s of ${(err.timeoutMs / 1000).toFixed(1)}s, ${String(err.pending)} pending`;
}

/** Writes the partial artifact JSON to the `.INCOMPLETE.json` path, creating parent directories as needed. Returns the path written. */
export function writeIncompleteArtifact(outPath: string, artifact: unknown): string {
  const incompletePath = toIncompleteOutPath(resolve(process.cwd(), outPath));
  mkdirSync(resolve(incompletePath, '..'), { recursive: true });
  writeFileSync(incompletePath, JSON.stringify(artifact, null, 2), 'utf8');
  return incompletePath;
}

/**
 * Called from `run-pg-load.ts`'s `waitForDrain` catch block: takes the AFTER
 * snapshot anyway (Harness gap - evidence of a partial run must still be
 * written), builds a `drain: { complete: false, ... }` artifact, prints the
 * validator's problems, and writes it to `.INCOMPLETE.json`. Never throws on
 * the timeout path itself - a failure here would re-hide the very evidence
 * this fix exists to preserve.
 */
export async function writePartialArtifactOnDrainTimeout(
  err: DrainTimeoutError,
  deps: PartialArtifactDeps,
): Promise<void> {
  const drain = { complete: false, pendingAtEnd: err.pending, pendingSample: err.pendingSample };
  deps.notes.push(formatDrainTimeoutNote(err));

  const after = await takeSnapshot({
    pool: deps.pool,
    pgBouncerAdminUrl: deps.pgBouncerAdminUrl,
    targetDatabase: deps.targetDatabase,
    instanceIds: deps.instanceIds,
    clientIds: deps.clientIds,
    now: () => Date.now(),
  });
  const observed = await readTerminalJobCount(deps.pool, deps.clientIds);
  const jobStatusHistogram = await readJobStatusHistogram(deps.pool, deps.clientIds);
  deps.notes.push(formatSweepCountsNote(deps.sweeps.counts()));

  const artifact = buildPgLoadArtifact({
    capturedAtIso: new Date().toISOString(),
    hardware: readHardwareFingerprint(),
    node: process.version,
    viaPgBouncer: deps.viaPgBouncer,
    window: { startMs: deps.before.atMs, endMs: after.atMs },
    sends: { attempted: deps.sendPlan.length * deps.perPlanItem, observed },
    delta: diffSnapshots(deps.before, after),
    projectAt: deps.args.projectedAt.map((connected) => ({
      connected,
      sendsPerDayPerInstance: deps.projectedSendsPerDay.value,
    })),
    baseline: deps.baseline,
    concurrentNote: deps.args.concurrentNote,
    jobStatusHistogram,
    drain,
    notes: deps.notes,
  });

  const { problems } = validatePgLoadArtifact(artifact);
  console.error('run-pg-load: drain timed out - writing a partial, UNPUBLISHABLE artifact:');
  for (const p of problems) console.error(`  - ${p}`);
  const written = writeIncompleteArtifact(deps.args.out, artifact);
  console.log(`run-pg-load: partial artifact written to ${written}`);
}
