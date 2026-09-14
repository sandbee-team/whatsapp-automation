import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createPool, createTenantDb } from '@wp/db';
import { describeError } from '@wp/server-kit';
import { parseRunPacingArgs, readRunPacingHardware } from './run-pacing-args.js';
import { resolveDatabaseUrl, resolvePgBouncerDatabaseUrl } from '../../platform/db/db-url.js';
import { createScaleFleet, type ScaleFleet } from './scale-fleet.js';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
} from '../session/synthetic-fleet-support.js';
import {
  expandTenantMix,
  parseTenantMix,
  perInstanceIntervalMs,
  type ExpandedTenant,
} from '../../../../../scripts/loadtest/tenant-mix.js';
import { runSendLoad } from './send-load-driver.js';
import { planCanSendWithin } from '../../../../../scripts/measure/pacing-run.js';
import {
  deriveReserveLatency,
  deriveBurstWindows,
  createRunPacingEnqueue,
  buildSendPlan,
  buildPacingRunJobs,
  formatSweepCountsNote,
  resolveFleetInstances,
  setRunPacingCaps,
  settleCleanup,
  startPacingSamplers,
} from './run-pacing-windows.js';
import { buildPacingRunArtifact } from '../../../../../scripts/measure/pacing-run-artifact.js';
import { formatPacingRunSummary } from '../../../../../scripts/measure/pacing-run-verify.js';
import {
  collectCapViolations,
  collectJobCounts,
  collectDuplicateAckedAttemptCount,
} from './run-pacing-collect.js';
import { createMeasureSweeps } from './measure-sweeps.js';

/**
 * run-pacing.ts (P26 U5, step 5 - THE CORE OF GATE B) - the RUNNABLE half of
 * the 1,000-instance pacing-run + M14 burst harness: stands up a real
 * `ScaleFleet`, seeds pacing caps off the tenant mix's steady-state send
 * rate, drives `runSendLoad` with the mix's burst, samples `reserve()` and
 * non-bursting-tenant claim latency, collects every count from ROWS
 * (invariant 7) and writes the `PacingRunArtifact`. Split siblings:
 * `run-pacing-collect.ts` (queries + samplers), `run-pacing-windows.ts`
 * (sample -> artifact-field derivation, incl. `jobs`/sweep-note assembly).
 *
 * CAP SIZING (why "zero violations" is not vacuous): `eff_daily_cap` is
 * UPDATEd to roughly the sends ONE heavy instance accumulates during
 * `--minutes` (not the 2,000/day ceiling), so the run genuinely brushes the
 * cap - recorded verbatim in the artifact's own `notes`.
 *
 * RESERVE LATENCY SAMPLING: a dedicated sampler runs `timeOneReserveCall`
 * (the REAL `reserve()` port) against its OWN probe instances on a fixed
 * cadence for the whole run - never the children's Prometheus histogram and
 * never a `SELECT 1`.
 *
 * TIME BASES (each one was a live defect in the first 200-instance smoke):
 *  - `driveStartedAtMs` opens the DRIVE window, AFTER stand-up.
 *    `run.measuredSeconds` is measured from it; stand-up is reported
 *    separately as `run.standUpSeconds` and never counted as run time.
 *  - `burstAtMs` is the ONE absolute instant the burst fires at, derived
 *    from `--burst-at-seconds` (never the mix file's own default) and shared
 *    by the send driver and the claim sampler's bucketing, so the artifact's
 *    run-relative `burst.startedAtMs` always matches what actually happened.
 *
 * FAIRNESS WINDOWS (M14): `timeOneClaimProbe` samples run continuously
 * against NON-bursting probe instances; `bucketClaimSample` splits them at
 * `burstAtMs`. An EMPTY window is reported `null` and named as its own
 * problem - never 0, never a ratio of Infinity.
 */

async function main(): Promise<void> {
  const args = parseRunPacingArgs(process.argv.slice(2));
  const mixPath = resolve(process.cwd(), 'scripts/loadtest/tenant-mix.json');
  const mix = parseTenantMix(JSON.parse(readFileSync(mixPath, 'utf8')));
  const expanded = expandTenantMix(mix, args.instances);
  const heaviestSendsPerDay = Math.max(
    ...(expanded.tenants as ExpandedTenant[]).map((t) => t.sendsPerDayPerInstance),
  );
  // Seed the daily cap at roughly what ONE heavy instance will accumulate
  // over the run's own duration - see this file's own CAP SIZING note.
  const seededDailyCap = Math.max(10, Math.ceil((heaviestSendsPerDay * args.minutes) / (24 * 60)));
  const notes = [
    `eff_daily_cap set to ${String(seededDailyCap)} by UPDATE on the fleet's own assigned ` +
      `instances (derived from the heaviest tenant class's ${String(heaviestSendsPerDay)} sends/day ` +
      `over this run's ${String(args.minutes)}-minute duration) - sized so the run genuinely ` +
      'approaches the cap, never a vacuous "nothing to check" result.',
  ];

  // REFUSE a run too short for even the fastest class to send once: it would
  // report `jobs.enqueued=0`, indistinguishable from a mis-scoped query.
  // Checked BEFORE stand-up, so a refused run seeds (and leaks) nothing.
  const durationMs = args.minutes * 60_000;
  const canSend = planCanSendWithin(
    (expanded.tenants as ExpandedTenant[]).map((t) => ({
      key: t.key,
      intervalMs: perInstanceIntervalMs(t.sendsPerDayPerInstance),
    })),
    durationMs,
  );
  if (!canSend.ok) throw new Error(`run-pacing: ${String(canSend.reason)}`);

  const handles = createSyntheticFleetHandles();
  const plan = {
    workers: args.workers,
    instancesPerWorker: Math.ceil(args.instances / args.workers),
    tenants: (expanded.tenants as ExpandedTenant[]).length,
    sessionCap: Math.ceil(args.instances / args.workers) + 1,
  };
  const fleet: ScaleFleet = createScaleFleet({
    handles,
    plan,
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });

  const pgBouncerUrl = resolvePgBouncerDatabaseUrl();
  const viaPgBouncer = pgBouncerUrl !== null;
  if (!viaPgBouncer) {
    notes.push(
      'PgBouncer was unreachable at run start - reserve() latency falls back to a DIRECT connection.',
    );
  }
  const samplePool = createPool({
    connectionString: pgBouncerUrl ?? resolveDatabaseUrl(),
    applicationName: 'pacing-run-sampler',
  });

  const standUpStartedAtMs = Date.now();
  // Reaper+reconciler on production cadence (`measure-sweeps.ts`'s own
  // header: without them a stranded `processing` job can never drain).
  // Started right after `fleet.start()`, stopped in `finally`.
  const sweeps = createMeasureSweeps({
    pool: handles.pool,
    tenantDb: createTenantDb(handles.pool),
  });
  try {
    await fleet.start();
    sweeps.start();
    // The fleet's OWN assigned instances are this run's only instance set -
    // never a second `seedScaleFleet` (see `resolveFleetInstances`). The
    // run-derived cap is applied by UPDATE on exactly those rows.
    const seeded = await resolveFleetInstances(handles.pool, fleet);
    const ids = seeded.instances.map((i) => i.instanceId);
    const capped = await setRunPacingCaps(handles.pool, ids, seeded.clientIds, seededDailyCap);
    if (capped !== ids.length) {
      throw new Error(
        `run-pacing: cap UPDATE touched ${String(capped)} rows, expected ${String(ids.length)}`,
      );
    }

    const sendPlan = buildSendPlan(expanded.tenants as ExpandedTenant[], seeded.instances);

    const burstSpec = mix.burstTenant;
    const burstInstance = seeded.instances[0];
    const probeInstances = seeded.instances.slice(0, Math.min(5, seeded.instances.length));
    const nonBurstProbeInstances = seeded.instances.slice(1, Math.min(6, seeded.instances.length));

    // THE DRIVE WINDOW opens here, after stand-up: `measuredSeconds` is
    // measured from it, never from process start (see TIME BASES above).
    const standUpSeconds = (Date.now() - standUpStartedAtMs) / 1000;
    const driveStartedAtMs = Date.now();
    // ONE absolute burst instant, shared by the send driver and the claim
    // sampler's bucketing (see TIME BASES above).
    const burstAtMs = driveStartedAtMs + args.burstAtSeconds * 1000;
    const samplers = startPacingSamplers(
      samplePool,
      probeInstances,
      nonBurstProbeInstances[0],
      burstAtMs,
    );

    const enqueue = createRunPacingEnqueue(handles.pool, handles.redisCtl);

    console.log(
      `run-pacing: ${String(plan.workers)} workers / ${String(seeded.instances.length)} instances / ` +
        `${String(seeded.clientIds.length)} tenants, ${String(args.minutes)}min, burst at ${String(args.burstAtSeconds)}s`,
    );

    const result = await runSendLoad(
      sendPlan,
      { enqueue, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      {
        durationMs,
        jitterRatio: 0.1,
        rng: Math.random,
        burst:
          burstSpec && burstInstance
            ? {
                atMs: burstAtMs,
                clientId: burstInstance.clientId,
                instanceId: burstInstance.instanceId,
                recipients: args.burstRecipients,
                tenantKey: burstSpec.key,
              }
            : undefined,
      },
    );

    samplers.signal.stopped = true;
    await samplers.join();

    const { violations: capViolations, ledgerRowCount } = await collectCapViolations(
      handles.pool,
      ids,
      seeded.clientIds,
    );
    const jobCountsRaw = await collectJobCounts(handles.pool, seeded.clientIds);
    const duplicateAckedAttempts = await collectDuplicateAckedAttemptCount(
      handles.pool,
      seeded.clientIds,
    );
    const measuredSeconds = (Date.now() - driveStartedAtMs) / 1000;
    notes.push(formatSweepCountsNote(sweeps.counts()));

    const artifact = buildPacingRunArtifact({
      schemaVersion: 1,
      kind: 'pacing-run',
      capturedAtIso: new Date().toISOString(),
      hardware: readRunPacingHardware(),
      node: process.version,
      run: {
        plannedSeconds: args.minutes * 60,
        measuredSeconds,
        standUpSeconds,
        instances: seeded.instances.length,
        workers: plan.workers,
        tenants: seeded.clientIds.length,
      },
      connection: {
        viaPgBouncer,
        poolMode: viaPgBouncer ? 'transaction' : null,
        label: viaPgBouncer ? 'THROUGH-PGBOUNCER' : 'DIRECT-CONNECTION',
      },
      reserveLatency: deriveReserveLatency(samplers.reserveSamples),
      capViolations,
      jobs: buildPacingRunJobs({
        jobCounts: jobCountsRaw,
        // `result.enqueued` already counts EVERY enqueue including the burst (`burstEnqueued` is a
        // subset, send-load-driver.ts:104-106); adding them double-counted the burst in the
        // 2026-09-07 60-min run (206,540 vs 106,540 rows - run log row 31).
        driverEnqueued: result.enqueued,
        ledgerRowCount,
        duplicateAckedAttempts,
      }),
      burst: burstSpec
        ? deriveBurstWindows({
            recipients: args.burstRecipients,
            // The RUN-RELATIVE offset the burst ACTUALLY fired at - the same
            // instant the sampler bucketed against, expressed against the
            // drive-window start. Never the mix file's own default.
            startedAtMs: burstAtMs - driveStartedAtMs,
            before: samplers.claimSamplesBefore,
            during: samplers.claimSamplesDuring,
          })
        : null,
      orphanReservations: {
        measurable: false,
        reason:
          'wp_pacing_orphan_reservations_total does not exist in v1 (P25, RUNBOOK.md#deferred-alerts)',
      },
      notes,
    });

    mkdirSync(resolve(args.out, '..'), { recursive: true });
    writeFileSync(resolve(process.cwd(), args.out), JSON.stringify(artifact, null, 2));
    console.log(formatPacingRunSummary(artifact));
    console.log(`run-pacing: artifact written to ${args.out}`);
    process.exitCode = artifact.verdict === 'PASS' ? 0 : 1;
  } finally {
    // Runs on EVERY path - PASS, FAIL, or exception - so a FAIL verdict can
    // never leak probe clients. `fleet.stop()` runs `cleanupScaleFleet` over
    // the ids it seeded, which (with no second seed) is every id this run
    // created. Each step is guarded so one failure never skips the others.
    sweeps.stop();
    await settleCleanup(fleet.stop());
    await settleCleanup(samplePool.end());
    await settleCleanup(disposeSyntheticFleetHandles(handles));
  }
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  // Matches run-pg-load.ts: an exception must set a non-zero exit code, not
  // become an unhandled rejection.
  main().catch((err: unknown) => {
    console.error(describeError(err));
    process.exitCode = 1;
  });
}
