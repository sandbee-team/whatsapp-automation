import { createRedis, resolveSigRedisUrl } from '../../platform/redis.js';
import {
  deployWaveSize,
  assertFlushTargetAllowed,
  type ChaosRunRecord,
} from '../../../../../scripts/chaos/run-chaos.js';
import {
  TAKEOVER_SLO_MS,
  baseRecord,
  waitForOutcome,
  warmUpUntilSendsFlow,
  jobStatusTally,
  readFence,
  readFences,
  sweepUntilExplained,
  readLinkStates,
  readCredVersions,
  countStillOwnedBy,
  countSendAttempts,
  type ScenarioContext,
} from './run-chaos-fleet-reads.js';

/**
 * run-chaos-fleet-scenarios.ts (P26 U6c) - the four scenario BODIES run by
 * `run-chaos-fleet.ts` (max-lines split - `run-pg-load-fleet.ts` idiom).
 * Every number is read from Postgres ROWS, `fleet.ownerMap()` or a real
 * Redis `dbsize` - never a harness running total (invariant 7). Pure halves
 * come from `scripts/chaos/run-chaos.ts`; shared readers/sweep live in
 * `run-chaos-fleet-reads.ts`.
 */

export type { ScenarioContext };

/** MAJOR 8: `sendsObserved` is an SLO ('> 0') in every `sloTargets` but was never a `problems` entry when 0 - the runner seeds a wake-published backlog first (`warmUpUntilSendsFlow`), so 0 is a real failure now. */
function pushSendsObservedProblem(record: ChaosRunRecord, sendsObserved: number): void {
  if (sendsObserved === 0) {
    record.problems.push('sendsObserved is 0 - the send path was never exercised by this run');
  }
}

/** kill -9 one worker, reassign its instances to the survivors, measure takeover + explained-reconcile + job identity. */
export async function runWorkerKill(ctx: ScenarioContext): Promise<ChaosRunRecord> {
  const record = baseRecord('worker-kill', ctx);
  const { fleet, pool } = ctx;
  const victim = ctx.workerIds[0] as string;
  const survivors = ctx.workerIds.slice(1);

  const beforeOwners = await fleet.ownerMap();
  const allInstanceIds = [...beforeOwners.keys()];
  const victimInstanceIds = [...beforeOwners.entries()]
    .filter(([, owner]) => owner === victim)
    .map(([id]) => id);
  const fenceBefore = await readFences(pool, allInstanceIds, ctx.clientIds);
  const jobsBefore = await jobStatusTally(pool, allInstanceIds, ctx.clientIds);
  await warmUpUntilSendsFlow(pool, allInstanceIds, ctx.clientIds); // sends in flight when the kill lands

  fleet.kill9(victim);
  const results = await fleet.reassignDeadWorkerInstances(victim, survivors);

  const takeoverMsValues = results.map((r) => r.takeoverMs).sort((a, b) => a - b);
  const takeoverMaxMs = takeoverMsValues.at(-1) ?? 0;
  const p99Index = Math.max(0, Math.ceil(takeoverMsValues.length * 0.99) - 1);
  const takeoverP99Ms = takeoverMsValues[p99Index] ?? 0;

  const afterOwners = await fleet.ownerMap();
  let fenceStrictlyIncreasedCount = 0;
  for (const id of victimInstanceIds) {
    const after = await readFence(pool, id, ctx.clientIds);
    const before = fenceBefore.get(id);
    if (after !== undefined && before !== undefined && after > before) {
      fenceStrictlyIncreasedCount += 1;
    }
  }

  const beforeSweep = await jobStatusTally(pool, allInstanceIds, ctx.clientIds);
  const needsReconcileProduced = beforeSweep.byStatus.get('needs_reconcile') ?? 0;
  await sweepUntilExplained(pool);
  const afterSweep = await jobStatusTally(pool, allInstanceIds, ctx.clientIds);
  const needsReconcileRemaining = afterSweep.byStatus.get('needs_reconcile') ?? 0;
  const needsReconcileExplained = needsReconcileProduced - needsReconcileRemaining;
  const jobsLost = jobsBefore.total - afterSweep.total;
  const sendsObserved = await countSendAttempts(pool, allInstanceIds, ctx.clientIds);

  // Replace the killed child so the fleet still has `workers` live children.
  await fleet.spawn(victim);

  record.measurements = {
    sendsObserved,
    takeoverMaxMs,
    takeoverP99Ms,
    instancesReassigned: results.length,
    fenceStrictlyIncreasedCount,
    needsReconcileProduced,
    needsReconcileExplained,
    needsReconcileRemaining,
    instancesStillOwned: afterOwners.size,
    jobsLost,
  };
  record.sloTargets = {
    sendsObserved: '> 0 (a run with zero send_attempts rows proves nothing about the send path)',
    takeoverMaxMs: `<= ${String(TAKEOVER_SLO_MS)} ms`,
    takeoverP99Ms: `<= ${String(TAKEOVER_SLO_MS)} ms`,
    needsReconcileRemaining: '== 0 (resolved or blocked_needs_review, never silent queued)',
    jobsLost: '== 0 (row-count identity)',
  };
  if (takeoverMaxMs > TAKEOVER_SLO_MS) {
    record.problems.push(
      `takeoverMaxMs ${String(takeoverMaxMs)} exceeded ${String(TAKEOVER_SLO_MS)}`,
    );
  }
  if (jobsLost !== 0) record.problems.push(`jobsLost ${String(jobsLost)} - expected 0`);
  if (needsReconcileRemaining !== 0) {
    record.problems.push(`needsReconcileRemaining ${String(needsReconcileRemaining)} - expected 0`);
  }
  pushSendsObservedProblem(record, sendsObserved);
  if (record.problems.length > 0) record.verdict = 'FAIL';
  return record;
}

/**
 * FLUSHALL the control plane only. `assertFlushTargetAllowed` runs FIRST and
 * throws for anything but `redis-ctl`, before any Redis I/O.
 * `redisSigDbsizeDelta` is read through a SEPARATE connection to the real
 * `resolveSigRedisUrl()` server - every synthetic handle here resolves to the
 * SAME physical server, so a diff on the fleet's own handle proves nothing.
 */
export async function runRedisFlush(ctx: ScenarioContext): Promise<ChaosRunRecord> {
  assertFlushTargetAllowed(ctx.flushTarget);

  const record = baseRecord('redis-flush', ctx);
  const { fleet, handles, pool } = ctx;
  const beforeOwners = await fleet.ownerMap();
  const allInstanceIds = [...beforeOwners.keys()];
  const fenceBefore = await readFences(pool, allInstanceIds, ctx.clientIds);
  await warmUpUntilSendsFlow(pool, allInstanceIds, ctx.clientIds); // claims flowing before the flush

  const sigProbe = createRedis(resolveSigRedisUrl());
  try {
    const sigBefore = await sigProbe.dbsize();
    const flushedAtMs = Date.now();
    await handles.redisCtl.flushall();

    const resumed = await waitForOutcome(async () => {
      const after = await fleet.ownerMap();
      return after.size === allInstanceIds.length;
    }, ctx.outcomeDeadlineMs);
    // Renamed from msToFirstClaimAfterFlush (MINOR c): measures re-ownership, not first claim.
    const msToAllInstancesReownedAfterFlush = Date.now() - flushedAtMs;
    const sigAfter = await sigProbe.dbsize();

    const afterOwners = await fleet.ownerMap();
    let fenceRegressionDelta = 0;
    for (const id of allInstanceIds) {
      const after = await readFence(pool, id, ctx.clientIds);
      const before = fenceBefore.get(id);
      if (after !== undefined && before !== undefined && after < before) {
        fenceRegressionDelta += Number(before - after);
      }
    }

    const sendsObserved = await countSendAttempts(pool, allInstanceIds, ctx.clientIds);
    record.measurements = {
      sendsObserved,
      msToAllInstancesReownedAfterFlush,
      fenceRegressionDelta,
      instancesStillOwned: afterOwners.size,
      redisSigDbsizeDelta: sigAfter - sigBefore,
    };
    record.sloTargets = {
      sendsObserved: '> 0 (a run with zero send_attempts rows proves nothing about the send path)',
      fenceRegressionDelta: '== 0 (fence is strictly monotonic per instance)',
      instancesStillOwned: `== ${String(allInstanceIds.length)} (no instance orphaned by a ctl flush)`,
      redisSigDbsizeDelta: '== 0 (the ratchet store is never touched, ADR 0018 S5)',
    };
    record.notes.push(
      'redisSigDbsizeDelta read through a SEPARATE resolveSigRedisUrl() connection - inside this ' +
        'harness handles.redisSig resolves to the same physical server as redisCtl, so a diff on ' +
        'the fleet handle would prove nothing.',
    );
    if (fenceRegressionDelta !== 0) {
      record.problems.push(`fenceRegressionDelta ${String(fenceRegressionDelta)} - expected 0`);
    }
    if (!resumed)
      record.problems.push('not every instance was re-owned within the outcome deadline');
    if (sigAfter !== sigBefore) {
      record.problems.push(
        `redis-sig dbsize changed (${String(sigBefore)} -> ${String(sigAfter)})`,
      );
    }
    pushSendsObservedProblem(record, sendsObserved);
    if (record.problems.length > 0) record.verdict = 'FAIL';
    return record;
  } finally {
    sigProbe.disconnect();
  }
}

/** Waves of `deployWaveSize(...)` workers: graceful drain -> spawn -> reassign -> bounded outcome wait, per wave. */
export async function runRollingDeploy(ctx: ScenarioContext): Promise<ChaosRunRecord> {
  const record = baseRecord('rolling-deploy', ctx);
  const { fleet, pool } = ctx;
  const waveSize = deployWaveSize({
    fleetSessions: ctx.fleetShape.instances,
    sessionsPerWorker: ctx.fleetShape.sessionsPerWorker,
  });

  const beforeOwners = await fleet.ownerMap();
  const allInstanceIds = [...beforeOwners.keys()];
  const linkStatesBefore = await readLinkStates(pool, allInstanceIds, ctx.clientIds);
  const credBefore = await readCredVersions(pool, allInstanceIds, ctx.clientIds);
  const jobsBefore = await jobStatusTally(pool, allInstanceIds, ctx.clientIds);
  await warmUpUntilSendsFlow(pool, allInstanceIds, ctx.clientIds); // deploy UNDER send load

  let waves = 0;
  let drainExitCodesNonZero = 0;
  let maxSimultaneouslyUnowned = 0;
  let reownFailures = 0;

  for (let i = 0; i < ctx.workerIds.length; i += waveSize) {
    const wave = ctx.workerIds.slice(i, i + waveSize);
    waves += 1;
    const waveInstanceIds: string[] = [];
    for (const workerId of wave) {
      const owners = await fleet.ownerMap();
      const ids = [...owners.entries()].filter(([, o]) => o === workerId).map(([id]) => id);
      waveInstanceIds.push(...ids);
      const exitCode = await fleet.drain(workerId);
      if (exitCode !== 0) drainExitCodesNonZero += 1;
    }
    // Mid-transition population right after this wave's drains (worst case).
    const unowned = await countStillOwnedBy(pool, waveInstanceIds, wave, ctx.clientIds);
    maxSimultaneouslyUnowned = Math.max(maxSimultaneouslyUnowned, unowned);

    for (const workerId of wave) {
      await fleet.spawn(workerId);
      await fleet.reassignDeadWorkerInstances(workerId, [workerId]);
    }
    const reowned = await waitForOutcome(async () => {
      const after = await fleet.ownerMap();
      return waveInstanceIds.every((id) => wave.includes(after.get(id) ?? ''));
    }, ctx.outcomeDeadlineMs);
    if (!reowned) reownFailures += 1;
  }

  const linkStatesAfter = await readLinkStates(pool, allInstanceIds, ctx.clientIds);
  const credAfter = await readCredVersions(pool, allInstanceIds, ctx.clientIds);
  let reQrCount = 0;
  for (const id of allInstanceIds) {
    // A real re-QR demotes link_state off 'linked' and lowers cred_version -
    // storage-layer evidence, never a fabricated QR-count (FakeSock emits no `qr`).
    if (linkStatesBefore.get(id) === 'linked' && linkStatesAfter.get(id) !== 'linked')
      reQrCount += 1;
    const before = credBefore.get(id);
    const after = credAfter.get(id);
    if (before !== undefined && after !== undefined && after < before) reQrCount += 1;
  }

  await sweepUntilExplained(pool);
  const afterSweep = await jobStatusTally(pool, allInstanceIds, ctx.clientIds);
  const needsReconcileUnexplained = afterSweep.byStatus.get('needs_reconcile') ?? 0;
  const jobsLost = jobsBefore.total - afterSweep.total;
  const sendsObserved = await countSendAttempts(pool, allInstanceIds, ctx.clientIds);
  const maxUnownedFraction =
    ctx.fleetShape.instances > 0 ? maxSimultaneouslyUnowned / ctx.fleetShape.instances : 0;

  record.measurements = {
    sendsObserved,
    waveSize,
    waves,
    drainExitCodesNonZero,
    maxSimultaneouslyUnowned,
    maxUnownedFraction: Number(maxUnownedFraction.toFixed(4)),
    reQrCount,
    jobsLost,
    needsReconcileUnexplained,
  };
  record.sloTargets = {
    sendsObserved: '> 0 (a run with zero send_attempts rows proves nothing about the send path)',
    waveSize: '<= 2% of fleet sessions per wave (SLO-derived, ADR 0018 S4)',
    drainExitCodesNonZero: '== 0 (every drain is graceful)',
    reQrCount: '== 0 (link_state stays linked, cred_version never regresses)',
    jobsLost: '== 0 (row-count identity)',
    needsReconcileUnexplained: '== 0 (resolved or blocked_needs_review)',
  };
  record.notes.push(
    'reQrCount is storage-layer evidence (link_state + cred_version), never a QR-event count - the harness FakeSock never emits a real qr event.',
  );
  if (drainExitCodesNonZero !== 0) record.problems.push('a drain exited non-zero');
  if (reQrCount !== 0) record.problems.push(`reQrCount ${String(reQrCount)} - expected 0`);
  if (jobsLost !== 0) record.problems.push(`jobsLost ${String(jobsLost)} - expected 0`);
  if (needsReconcileUnexplained !== 0) {
    record.problems.push(`needsReconcileUnexplained ${String(needsReconcileUnexplained)}`);
  }
  if (reownFailures !== 0)
    record.problems.push(`${String(reownFailures)} wave(s) never fully re-owned`);
  pushSendsObservedProblem(record, sendsObserved);
  if (record.problems.length > 0) record.verdict = 'FAIL';
  return record;
}
