import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPool, createTenantDb } from '@wp/db';
import { ABSOLUTE_GAP_MIN_MS } from '@wp/domain';
import { describeError } from '@wp/server-kit';
import { resolveDatabaseUrl, resolvePgBouncerDatabaseUrl } from '../../platform/db/db-url.js';
import { buildPgLoadArtifact, diffSnapshots } from '../../../../../scripts/measure/pg-load.js';
import {
  validatePgLoadArtifact,
  formatPgLoadSummary,
} from '../../../../../scripts/measure/pg-load-validate.js';
import { runSendLoad } from './send-load-driver.js';
import { createMeasureEnqueue } from './measure-enqueue.js';
import { createScaleFleet, type ScaleFleet } from './scale-fleet.js';
import { createMeasureSweeps } from './measure-sweeps.js';
import { formatSweepCountsNote } from './run-pacing-windows.js';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
} from '../session/synthetic-fleet-support.js';
import {
  buildScaleFleetPlan,
  buildSendPlanFromFleet,
  raiseSeededPacingCaps,
  waitForDrain,
  DrainTimeoutError,
} from './run-pg-load-fleet.js';
import {
  takeSnapshot,
  readTerminalJobCount,
  readJobStatusHistogram,
  sampleBaseline,
} from './run-pg-load-snapshots.js';
import {
  assertDrainFeasible,
  expectedDrainSeconds,
  parseRunPgLoadArgs,
  readHardwareFingerprint,
  resolveProjectedSendsPerDay,
  sendsPerInstance,
} from './run-pg-load-args.js';
import { runOrphanPreflight } from './run-pg-load-preflight.js';
import { OrphanAttemptLandmineError } from './orphan-attempts-preflight.js';
import { writePartialArtifactOnDrainTimeout } from './run-pg-load-incomplete.js';

/**
 * run-pg-load.ts (P26 U4, M8+M9 measured load model) - the runnable harness:
 * stands up a REAL `ScaleFleet` (`scale-fleet.ts`, U2a), raises its seeded
 * pacing caps to fit the requested sends, drives real sends through
 * `runSendLoad`, waits for drain by POLLING a row-count predicate (never a
 * fixed sleep), then builds + validates + writes the `PgLoadArtifact` via
 * the PURE `scripts/measure/pg-load.ts`. isMain-guarded (idiom:
 * `run-restore-verify.ts`). FIX-P26-E adds a read-only orphan-attempts
 * preflight (`run-pg-load-preflight.ts`) BEFORE `fleet.start()`, and a
 * `.INCOMPLETE.json` partial-artifact path (`run-pg-load-incomplete.ts`) on
 * a `DrainTimeoutError` - see those modules' own headers.
 *
 * DRAIN ARITHMETIC (the reason the first real run failed): enqueue rate does
 * NOT set the pace - the pacing gate does. Drain time is bounded below by
 * `ceil(sends/instances) * max(ABSOLUTE_GAP_MIN_MS, SCALE_FLEET_SAFETY_POLL_MS)`,
 * computed, PRINTED, and ENFORCED before any row is seeded by
 * `run-pg-load-args.ts` (`expectedDrainSeconds`, `assertDrainFeasible`).
 *
 * `sends.observed` is counted from `message_jobs` ROWS ONLY (invariant 7),
 * cross-checked against `pacing_ledger.consumed_count` - a >1% disagreement
 * is a named discrepancy in `notes`, never averaged away.
 *
 * SNAPSHOT ORDERING: the BEFORE snapshot is taken AFTER `fleet.start()` and
 * the cap raise, so stand-up is excluded from the measured delta.
 */

/** Same host/user/password/port as `pgBouncerUrl`, database swapped to the `pgbouncer` admin database (`ADMIN_USERS` includes our app user - `infra/compose/docker-compose.dev.yml`). */
function toPgBouncerAdminUrl(pgBouncerUrl: string): string {
  const url = new URL(pgBouncerUrl);
  url.pathname = '/pgbouncer';
  return url.toString();
}

async function main(): Promise<void> {
  const args = parseRunPgLoadArgs(process.argv.slice(2));
  assertDrainFeasible(args);

  const perInstance = sendsPerInstance(args.sends, args.instances);
  const drainSeconds = expectedDrainSeconds(args.sends, args.instances);
  console.log(
    `run-pg-load: ${String(args.sends)} sends / ${String(args.instances)} instances = ` +
      `${String(perInstance)} sends per instance; at max(pacing gap ${String(ABSOLUTE_GAP_MIN_MS)}ms, safety poll) per instance ` +
      `floor the expected drain is ${String(drainSeconds)}s (${(drainSeconds / 60).toFixed(1)} min); ` +
      `drain timeout ${String(args.drainTimeoutMinutes)} min ` +
      `(${args.drainTimeoutDerived ? 'derived' : 'from --drain-timeout-minutes'}); ` +
      `seeding eff_hourly_cap=${String(args.hourlyCap)} eff_daily_cap=${String(args.dailyCap)}`,
  );

  const pgBouncerUrl = resolvePgBouncerDatabaseUrl();
  if (args.forcePgBouncer && pgBouncerUrl === null) {
    throw new Error(
      'run-pg-load: --via-pgbouncer was passed but resolvePgBouncerDatabaseUrl() returned null (PgBouncer not configured/reachable)',
    );
  }
  const viaPgBouncer = pgBouncerUrl !== null;
  const pgBouncerAdminUrl = pgBouncerUrl ? toPgBouncerAdminUrl(pgBouncerUrl) : null;
  const targetDatabase = new URL(resolveDatabaseUrl()).pathname.replace(/^\//, '');

  const pool = createPool({
    connectionString: pgBouncerUrl ?? resolveDatabaseUrl(),
    applicationName: 'pg-load-measure',
  });
  const projectedSendsPerDay = resolveProjectedSendsPerDay({
    sendsPerDay: args.sendsPerDay,
    instances: args.instances,
  });
  const notes: string[] = [
    `measurement condition: eff_hourly_cap=${String(args.hourlyCap)} and eff_daily_cap=${String(args.dailyCap)} were seeded on this run's own probe instances so ${String(perInstance)} sends/instance can drain - RUN CONDITIONS, not tenant settings (scale-fleet-seed defaults are 60/600).`,
    `drain arithmetic: ceil(${String(args.sends)}/${String(args.instances)}) x max(ABSOLUTE_GAP_MIN_MS ${String(ABSOLUTE_GAP_MIN_MS)}ms, SCALE_FLEET_SAFETY_POLL_MS) = ${String(drainSeconds)}s expected drain floor (one claim per trigger; no next_eligible_at nudge - P26 run log #17).`,
    'window excludes fleet stand-up: pg_stat_statements_reset() and the BEFORE snapshot are taken after fleet.start() and after the pacing-cap UPDATE.',
    `projection uses ${String(projectedSendsPerDay.value)} sends/day/instance from ${projectedSendsPerDay.source} - a tenant-behaviour INPUT, not something this synthetic run measures.`,
  ];
  if (!viaPgBouncer) {
    notes.push(
      'DIRECT-CONNECTION: resolvePgBouncerDatabaseUrl() returned null (PgBouncer not configured/reachable) - measured against Postgres directly',
    );
  }

  // FIX-P26-E: refuses the run BEFORE any row is seeded (no fleet exists yet
  // to clean up). No --skip-preflight escape hatch - see module header.
  try {
    notes.push(await runOrphanPreflight(pool, { sends: args.sends, instances: args.instances }));
  } catch (err) {
    if (err instanceof OrphanAttemptLandmineError) {
      console.error(err.message);
      process.exitCode = 1;
      await pool.end();
      return;
    }
    throw err;
  }

  const handles = createSyntheticFleetHandles();
  const plan = buildScaleFleetPlan(args);
  const fleet: ScaleFleet = createScaleFleet({ handles, plan });
  // Production sweeps (`roles/cron.ts`) reap DispatchAlreadyRecorded/expired
  // leases - without them a stranded job never self-heals (Harness gap).
  const sweeps = createMeasureSweeps({ pool, tenantDb: createTenantDb(pool) });

  try {
    await fleet.start();
    sweeps.start();

    const {
      plan: sendPlan,
      clientIds,
      instanceIds,
    } = await buildSendPlanFromFleet(pool, fleet, 1000);
    if (sendPlan.length === 0) {
      throw new Error('run-pg-load: fleet seeded zero assigned instances - nothing to measure');
    }
    const raised = await raiseSeededPacingCaps(pool, instanceIds, clientIds, args);
    if (raised !== instanceIds.length) {
      throw new Error(
        `run-pg-load: raised pacing caps on ${String(raised)} of ${String(instanceIds.length)} assigned instances - refusing to measure a partially-capped fleet`,
      );
    }

    const snapshotDeps = {
      pool,
      pgBouncerAdminUrl,
      targetDatabase,
      instanceIds,
      clientIds,
      now: () => Date.now(),
    };

    // MAJOR 5: idle baseline, sampled before the drive, subtracted below so
    // a second fleet sharing this Postgres is never folded into this run.
    const baseline = await sampleBaseline({ ...snapshotDeps, seconds: args.baselineSeconds });
    if (baseline === null) {
      notes.push(
        `--baseline-seconds 0 was explicitly passed - no idle baseline was sampled (concurrent load note: ${args.concurrentNote}).`,
      );
    }

    await pool.query('SELECT pg_stat_statements_reset()');
    const before = await takeSnapshot(snapshotDeps);

    const perPlanItem = Math.ceil(args.sends / sendPlan.length);
    await runSendLoad(
      sendPlan,
      {
        // Shared durable enqueue (two-table insert + wake publish, same as
        // the real path) - without the wake, children only fire on the 60s
        // safety poll. `env: 'test'` matches the fleet children's wake channel.
        enqueue: createMeasureEnqueue({ pool, redisCtl: handles.redisCtl, env: 'test' }),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { durationMs: perPlanItem * 1000, jitterRatio: 0, rng: () => 0.5 },
    );

    try {
      await waitForDrain(pool, clientIds, args.drainTimeoutMinutes * 60_000);
    } catch (err) {
      if (!(err instanceof DrainTimeoutError)) throw err;
      // FIX-P26-E: a drain timeout must still produce evidence.
      await writePartialArtifactOnDrainTimeout(err, {
        ...snapshotDeps,
        sweeps,
        notes,
        before,
        sendPlan,
        perPlanItem,
        args,
        viaPgBouncer,
        projectedSendsPerDay,
        baseline,
      });
      process.exitCode = 1;
      return;
    }

    const after = await takeSnapshot(snapshotDeps);
    const drain = { complete: true, pendingAtEnd: 0, pendingSample: [] };

    const observedFromRows = await readTerminalJobCount(pool, clientIds);
    const delta = diffSnapshots(before, after);
    if (delta.pacingConsumed > 0 && observedFromRows > 0) {
      const disagreement = Math.abs(observedFromRows - delta.pacingConsumed) / observedFromRows;
      if (disagreement > 0.01) {
        notes.push(
          `discrepancy: message_jobs terminal count (${String(observedFromRows)}) vs pacing_ledger consumed delta (${String(delta.pacingConsumed)}) differ by ${(disagreement * 100).toFixed(2)}%`,
        );
      }
    }
    if (observedFromRows < args.sends) {
      notes.push(
        `sample size: ${String(observedFromRows)} observed sends vs the ${String(args.sends)} requested over ${String(sendPlan.length)} assigned instances - see the drain-arithmetic note above.`,
      );
    }

    const jobStatusHistogram = await readJobStatusHistogram(pool, clientIds);
    notes.push(formatSweepCountsNote(sweeps.counts()));

    const artifact = buildPgLoadArtifact({
      capturedAtIso: new Date().toISOString(),
      hardware: readHardwareFingerprint(),
      node: process.version,
      viaPgBouncer,
      window: { startMs: before.atMs, endMs: after.atMs },
      sends: { attempted: sendPlan.length * perPlanItem, observed: observedFromRows },
      delta,
      projectAt: args.projectedAt.map((connected) => ({
        connected,
        sendsPerDayPerInstance: projectedSendsPerDay.value,
      })),
      baseline,
      concurrentNote: args.concurrentNote,
      jobStatusHistogram,
      drain,
      notes,
    });

    const { ok, problems } = validatePgLoadArtifact(artifact);
    console.log(formatPgLoadSummary(artifact));
    if (!ok) {
      console.error('run-pg-load: artifact FAILED validation:');
      for (const p of problems) console.error(`  - ${p}`);
    }

    const outPath = resolve(process.cwd(), args.out);
    mkdirSync(resolve(outPath, '..'), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2), 'utf8');
    console.log(`run-pg-load: artifact written to ${args.out}`);
    if (!ok) process.exitCode = 1;
  } finally {
    sweeps.stop();
    // fleet.stop() drains every child + runs cleanupScaleFleet - the only
    // cleanup needed for every row this run seeded; also runs on a timeout.
    await fleet.stop();
    await disposeSyntheticFleetHandles(handles);
    await pool.end();
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((err: unknown) => {
    console.error(describeError(err));
    process.exitCode = 1;
  });
}
