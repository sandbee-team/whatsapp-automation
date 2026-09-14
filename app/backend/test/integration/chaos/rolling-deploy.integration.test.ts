import { createMetricsRegistry } from '@wp/server-kit';
import { createTenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../../../src/engine/session/synthetic-fleet-support.js';
import { bindQueueMetrics } from '../../../src/engine/queue/metrics.js';
import { runOneReaperSweep, type ReaperDeps } from '../../../src/modules/queue/reaper.js';
import {
  runOneReconcilerSweep,
  type ReconcilerDeps,
} from '../../../src/modules/queue/reconciler.js';
import { createCountingNoOpRepairedSendSink } from '../../../src/modules/queue/repaired-send-sink.js';
import {
  deployWaveSize,
  validateChaosRunRecord,
  type ChaosRunRecord,
} from '../../../../../scripts/chaos/run-chaos.js';
import {
  readFence,
  readCredVersions,
  readLinkStates,
  countSendAttempts,
  warmUpUntilSendsFlow,
} from '../../../src/engine/measure/run-chaos-fleet-reads.js';
import {
  ROLLING_FLEET_PLAN,
  ROLLING_WORKER_IDS,
  startRollingFleet,
  rollOneWorker,
  seedWakePublishedJobsForInstances,
  aggregateJobStatuses,
} from './rolling-deploy-workload.js';
import type { ScaleFleet } from '../../../src/engine/measure/scale-fleet.js';

/**
 * rolling-deploy.integration.test.ts (P26 U6c, step 6 chaos: rolling deploy)
 * - the fleet-scale version of the unit-scale precedent
 * `fleet-recovery-rolling-restart.integration.test.ts`'s own
 * `rolling_deploy_causes_zero_re_QR_and_zero_unresolved`, re-run against the
 * REAL multi-PROCESS `ScaleFleet` harness (`createScaleFleet`, U2a) instead
 * of the in-process synthetic-worker harness, and driven by the SLO-derived
 * `deployWaveSize` formula (U6b) rather than a hand-picked wave constant.
 *
 * Fleet: 4 workers x 6 instances (24 total), sessionCap 12, COMPRESSED child
 * timing (`ROLLING_FLEET_PLAN`/`ROLLING_COMPRESSED_TIMING`,
 * `rolling-deploy-workload.ts`) - the same shape class as U6b's own
 * `CHAOS_FLEET_PLAN`, sized independently so this file's own fleet never
 * collides with U6b's two files if run concurrently (id-scoped cleanup makes
 * that safe either way, but a disjoint plan keeps the drill readable on its
 * own).
 *
 * UNDER LOAD: this file seeds a WAKE-PUBLISHED `message_jobs` backlog per
 * instance before rolling (`seedWakePublishedJobsForInstances`, via the
 * shared `measure-enqueue.ts` port - P26 C1 MAJOR 8 fix) and waits
 * (`warmUpUntilSendsFlow`) until the send loops are genuinely claiming before
 * the roll begins, so the roll happens UNDER live send traffic rather than
 * against carried-through queued rows nothing ever claims.
 *
 * RE-QR OBSERVABILITY: this harness's FakeSock never emits a real `qr` event
 * (see `synthetic-fleet-support.ts`'s own ABSOLUTE BOUNDARY doc comment), so
 * "zero re-QR" is proven via the STORAGE-LAYER evidence a real re-QR would
 * necessarily produce instead: `whatsapp_instances.link_state` stays
 * 'linked' for every instance across the whole roll (a re-QR always demotes
 * link_state away from 'linked' first), and
 * `whatsapp_session_credentials.cred_version` never resets/regresses per
 * instance (a fresh pairing always starts a new credential lineage at a
 * lower version than whatever this seed already wrote) - never a fabricated
 * QR-count read.
 *
 * MID-ROLL OWNERSHIP OBSERVABILITY (deviation, established empirically by
 * running this exact drill against the real fleet - not assumed): a
 * graceful `drain()` in this harness does NOT flip `instance_lease_state.
 * owner_worker_id` to NULL or advance `lease_seen_at` past staleness on its
 * own - the row still shows the just-drained worker as owner, `released_at`
 * stays NULL, immediately after `drain()` resolves with exit code 0.
 * Reassignment only happens once `reassignDeadWorkerInstances` completes its
 * own stale-lease wait and issues a real `assign` to the replacement (the
 * SAME mechanism `worker-kill.integration.test.ts` (U6b) uses for a hard
 * kill). So "currently mid-transition, not yet re-owned" is observed here as
 * "current owner is still the worker id that was just drained"
 * (`countStillOwnedBy`, `run-chaos-fleet-reads.ts`) - never a fabricated
 * `owner_worker_id IS NULL` read, which this harness never actually produces
 * for a graceful drain.
 */

let handles: SyntheticFleetHandles;
let fleet: ScaleFleet;

beforeAll(async () => {
  handles = createSyntheticFleetHandles();
  fleet = await startRollingFleet(handles);
}, 120_000);

afterAll(async () => {
  await fleet.stop();
  await disposeSyntheticFleetHandles(handles);
}, 60_000);

describe('rolling-deploy chaos drill (fleet scale, P26 U6c)', () => {
  it(
    'rolling_deploy_causes_zero_re_QR_and_zero_unresolved',
    async () => {
      const fleetSessions = ROLLING_FLEET_PLAN.workers * ROLLING_FLEET_PLAN.instancesPerWorker;
      const waveSize = deployWaveSize({
        fleetSessions,
        sessionsPerWorker: ROLLING_FLEET_PLAN.instancesPerWorker,
      });
      // At this small N the SLO formula floors to 1 worker per wave - that
      // IS the 2% ceiling working (max(1, floor(24*0.02/6)) = max(1, 0) = 1),
      // not a hand-picked constant. The roll below deliberately still walks
      // every worker one wave (of size 1) at a time so the formula genuinely
      // drives the roll's shape.
      expect(waveSize).toBe(1);

      const beforeOwners = await fleet.ownerMap();
      expect(beforeOwners.size).toBe(fleetSessions);
      const allInstanceIds = [...beforeOwners.keys()];
      const clientIds = fleet.clientIds();

      const jobIds = await seedWakePublishedJobsForInstances(handles.pool, fleet, handles);
      expect(jobIds.length).toBe(allInstanceIds.length);
      // Roll UNDER live send traffic, never against carried-through queued
      // work nothing ever claims (P26 C1 MAJOR 8 fix) - bounded wait until
      // the send loops are genuinely claiming the seeded backlog.
      await warmUpUntilSendsFlow(handles.pool, allInstanceIds, clientIds);

      const fenceBefore = new Map<string, bigint>();
      for (const instanceId of allInstanceIds) {
        const fence = await readFence(handles.pool, instanceId, clientIds);
        if (fence !== undefined) fenceBefore.set(instanceId, fence);
      }
      const credVersionsBefore = await readCredVersions(handles.pool, allInstanceIds, clientIds);
      const fenceChangeCounts = new Map<string, number>(allInstanceIds.map((id) => [id, 0]));

      const ceiling = waveSize * ROLLING_FLEET_PLAN.instancesPerWorker;
      let maxSimultaneouslyUnowned = 0;

      for (const workerId of ROLLING_WORKER_IDS) {
        const rolled = await rollOneWorker(fleet, handles.pool, workerId);
        const { targetInstanceIds } = rolled;
        expect(targetInstanceIds.length).toBeGreaterThan(0);
        // Graceful drain, never a kill: exit code 0 every wave.
        expect(rolled.exitCode).toBe(0);
        expect(rolled.reassignedCount).toBe(targetInstanceIds.length);
        expect(rolled.reowned).toBe(true);
        maxSimultaneouslyUnowned = Math.max(maxSimultaneouslyUnowned, rolled.unownedAfterDrain);

        for (const instanceId of targetInstanceIds) {
          const fenceAfterWave = await readFence(handles.pool, instanceId, clientIds);
          const before = fenceBefore.get(instanceId);
          expect(fenceAfterWave).toBeDefined();
          expect(before).toBeDefined();
          expect(fenceAfterWave! > before!).toBe(true);
          fenceChangeCounts.set(instanceId, (fenceChangeCounts.get(instanceId) ?? 0) + 1);
          fenceBefore.set(instanceId, fenceAfterWave!);
        }
      }

      // Every instance's fence strictly increased EXACTLY once (it changed
      // owner exactly once across the whole roll - each worker rolled once).
      for (const instanceId of allInstanceIds) {
        expect(fenceChangeCounts.get(instanceId)).toBe(1);
      }

      // Never more than one wave's worth of sessions mid-transition at once
      // (sampled from instance_lease_state rows - see this file's own header,
      // MID-ROLL OWNERSHIP OBSERVABILITY - never a timing margin).
      expect(maxSimultaneouslyUnowned).toBeLessThanOrEqual(ceiling);

      const afterOwners = await fleet.ownerMap();
      expect(afterOwners.size).toBe(fleetSessions);

      // ZERO re-QR (storage-layer evidence - see this file's own header):
      // link_state still 'linked' for every instance, and cred_version never
      // regressed.
      const linkStates = await readLinkStates(handles.pool, allInstanceIds, clientIds);
      for (const instanceId of allInstanceIds) {
        expect(linkStates.get(instanceId)).toBe('linked');
      }
      const credVersionsAfter = await readCredVersions(handles.pool, allInstanceIds, clientIds);
      for (const instanceId of allInstanceIds) {
        const before = credVersionsBefore.get(instanceId);
        const after = credVersionsAfter.get(instanceId);
        expect(after).toBeDefined();
        expect(before).toBeDefined();
        expect(after! >= before!).toBe(true);
      }

      // ZERO jobs lost: row-count identity (invariant 7, never a harness
      // tally). enqueued = sent + queued + terminal-failed + blocked_needs_
      // review + cancelled (+ any still 'processing'/'needs_reconcile' before
      // the sweep below runs).
      const beforeSweep = await aggregateJobStatuses(handles.pool, jobIds, clientIds);
      expect(beforeSweep.total).toBe(jobIds.length);

      // ZERO rows left in needs_reconcile unexplained: reaper sweep then
      // reconciler sweep, ending in blocked_needs_review or resolved, never
      // silently 'queued' (same discipline U6b's own worker-kill file uses).
      const metrics = bindQueueMetrics(createMetricsRegistry());
      const sink = createCountingNoOpRepairedSendSink();
      const tenantDb = createTenantDb(handles.pool);
      const reaperDeps: ReaperDeps = {
        pool: handles.pool,
        tenantDb,
        metrics,
        sink,
        graceSeconds: 30,
        limit: 1000,
        rng: { random: () => 0 },
      };
      await runOneReaperSweep(reaperDeps);
      const reconcilerDeps: ReconcilerDeps = {
        pool: handles.pool,
        tenantDb,
        metrics,
        sink,
        reconcileWindowMs: 5 * 60_000,
        echoToleranceMs: 5 * 60_000,
        maxRows: 1000,
        now: () => Date.now() + 5 * 60_000 + 60_000,
      };
      await runOneReconcilerSweep(reconcilerDeps);

      // LIVENESS (P26 C1 MAJOR 8 fix): the seeded backlog is wake-published
      // and warmed up before the roll (see this file's own UNDER LOAD note),
      // so a 0 here is now a real failure, never a vacuous pass.
      const sendsObserved = await countSendAttempts(handles.pool, allInstanceIds, clientIds);
      expect(sendsObserved).toBeGreaterThan(0);

      const afterSweep = await aggregateJobStatuses(handles.pool, jobIds, clientIds);
      expect(afterSweep.needs_reconcile).toBe(0);
      expect(afterSweep.total).toBe(jobIds.length);
      const accounted =
        afterSweep.sent +
        afterSweep.queued +
        afterSweep.failed +
        afterSweep.blocked_needs_review +
        afterSweep.cancelled;
      expect(accounted).toBe(jobIds.length);

      const record: ChaosRunRecord = {
        schemaVersion: 1,
        kind: 'chaos',
        scenario: 'rolling-deploy',
        capturedAtIso: new Date().toISOString(),
        fleet: {
          instances: fleetSessions,
          workers: ROLLING_FLEET_PLAN.workers,
          sessionsPerWorker: ROLLING_FLEET_PLAN.instancesPerWorker,
        },
        measurements: {
          waveSizeWorkers: waveSize,
          waves: ROLLING_WORKER_IDS.length,
          instancesRolled: allInstanceIds.length,
          jobsCarriedThrough: jobIds.length,
          sendsObserved,
          maxSimultaneouslyUnowned,
          needsReconcileRemaining: afterSweep.needs_reconcile,
        },
        sloTargets: {
          waveSizeWorkers: '<= 2% of fleet sessions per wave (SLO-derived, ADR 0018 S4)',
          needsReconcileRemaining: '== 0 (resolved or blocked_needs_review, never silent queued)',
          sendsObserved:
            '> 0 (a run with zero send_attempts rows proves nothing about the send path)',
        },
        verdict: 'PASS',
        problems: [],
        notes: [
          'zero re-QR proven via storage-layer evidence (link_state + cred_version), not a ' +
            "fabricated QR-count read - see this test file's own header.",
        ],
      };
      expect(validateChaosRunRecord(record).ok).toBe(true);
    },
    // 4 waves, each budgeted a real drain + spawn + up to 45s takeover wait.
    ROLLING_FLEET_PLAN.workers * 90_000 + 60_000,
  );
});
