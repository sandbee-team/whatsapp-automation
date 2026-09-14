import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../../../src/engine/session/synthetic-fleet-support.js';
import { deployWaveSize } from '../../../../../scripts/chaos/run-chaos.js';
import {
  ROLLING_FLEET_PLAN,
  ROLLING_WORKER_IDS,
  startRollingFleet,
  rollOneWorker,
} from './rolling-deploy-workload.js';
import type { ScaleFleet } from '../../../src/engine/measure/scale-fleet.js';

/**
 * rolling-deploy-wave.integration.test.ts (P26 U6c, step 6 chaos: rolling
 * deploy) - the WAVE-SIZE half of the drill, split out of
 * `rolling-deploy.integration.test.ts` purely for that file's own
 * `max-lines: 300` cap (established split idiom -
 * `session-worker-discovery-wiring.ts`). Shares the fleet shape, stand-up and
 * roll helper with its sibling via `rolling-deploy-workload.ts`; see that
 * sibling's own header for the RE-QR and MID-ROLL OWNERSHIP observability
 * deviations that apply to both files.
 *
 * This file proves the wave size is DERIVED from the SLO rather than
 * hand-picked, in two halves:
 *  - a pure table of `deployWaveSize` canon examples (including one large
 *    fleet where the floor genuinely exceeds 1, so a "always returns 1"
 *    implementation cannot satisfy the table); and
 *  - a LIVE half that rolls the real fleet a wave at a time and asserts the
 *    maximum simultaneously-mid-transition session count never exceeded
 *    `waveSize * sessionsPerWorker` - an OUTCOME sampled from
 *    `instance_lease_state` row counts, never a timing margin.
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

describe('rolling-deploy wave sizing (fleet scale, P26 U6c)', () => {
  it(
    'deploy_wave_size_is_derived_from_the_slo_not_a_constant',
    async () => {
      // Canon table (ADR 0018 S4 / design S4.3): wave size in WORKERS =
      // max(1, floor(fleetSessions * 0.02 / sessionsPerWorker)). Exact
      // expected values only - a bound would be satisfied by a wrong
      // implementation.
      expect(deployWaveSize({ fleetSessions: 10_000, sessionsPerWorker: 135 })).toBe(1);
      expect(deployWaveSize({ fleetSessions: 10_000, sessionsPerWorker: 69 })).toBe(2);
      expect(deployWaveSize({ fleetSessions: 2_000, sessionsPerWorker: 135 })).toBe(1);
      expect(deployWaveSize({ fleetSessions: 24, sessionsPerWorker: 6 })).toBe(1);
      // A large fleet where the floor genuinely exceeds 1: 20,000 sessions /
      // 50 sessions-per-worker => max(1, floor(20000*0.02/50)) = max(1, 8).
      expect(deployWaveSize({ fleetSessions: 20_000, sessionsPerWorker: 50 })).toBe(8);

      const fleetSessions = ROLLING_FLEET_PLAN.workers * ROLLING_FLEET_PLAN.instancesPerWorker;
      const waveSize = deployWaveSize({
        fleetSessions,
        sessionsPerWorker: ROLLING_FLEET_PLAN.instancesPerWorker,
      });
      // At this small N the SLO formula floors to 1 worker per wave - that IS
      // the 2% ceiling working (max(1, floor(24*0.02/6)) = max(1, 0) = 1),
      // not a hand-picked constant.
      expect(waveSize).toBe(1);
      const ceiling = waveSize * ROLLING_FLEET_PLAN.instancesPerWorker;
      expect(ceiling).toBe(6);

      // Live half: roll every worker one wave at a time, sampling the
      // mid-transition population immediately after each drain (the
      // worst-case moment for that wave).
      let maxUnowned = 0;
      for (const workerId of ROLLING_WORKER_IDS) {
        const rolled = await rollOneWorker(fleet, handles.pool, workerId);
        expect(rolled.targetInstanceIds.length).toBeGreaterThan(0);
        expect(rolled.targetInstanceIds.length).toBeLessThanOrEqual(ceiling);
        expect(rolled.exitCode).toBe(0);
        expect(rolled.reowned).toBe(true);
        maxUnowned = Math.max(maxUnowned, rolled.unownedAfterDrain);
      }

      expect(maxUnowned).toBeGreaterThan(0);
      expect(maxUnowned).toBeLessThanOrEqual(ceiling);
    },
    ROLLING_FLEET_PLAN.workers * 90_000 + 60_000,
  );
});
