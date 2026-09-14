import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { metrics } from '@wp/server-kit';
import { cleanupProbeClients as cleanupAuthStoreProbeClients } from '../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import { bindLeaseMetrics } from '../../platform/metrics/lease-metrics.js';
import { sysKey } from '../../platform/redis/keys.js';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
  type SyntheticWorkerHandle,
} from '../session/synthetic-fleet-support.js';
import { readBucket, redisNowMs } from './__tests__/fleet-bucket-snapshot.js';
import {
  maxTokensAvailable,
  snapshotBucketBefore,
  type BucketBracket,
} from './__tests__/fleet-recovery-bucket-conservation.js';
import {
  SCAN_ROWS_PER_CYCLE,
  SESSION_CAP_HEADROOM,
  readCounterValue,
  runStormSetup,
  type StormSetupResult,
} from './__tests__/fleet-recovery-test-support.js';

/**
 * fleet-recovery-storm.integration.test.ts (P09 U7 step 10, FIX-P09-B
 * split) - the kill -9 storm takeover + fence-regression half of
 * `fleet-recovery.integration.test.ts`, split out at FIX-P09-B for the
 * max-lines cap (topic split only - same cases, unchanged; the storm's own
 * setup/takeover sequence additionally moved into
 * `fleet-recovery-test-support.ts`'s `runStormSetup` as a pure code motion
 * for the same cap). See `fleet-recovery-rolling-restart.integration.test.ts`
 * for the rolling-deploy case, and this file's own header for the
 * SYNTHETIC-sockets-only boundary and TIMING discipline this whole exercise
 * runs under (verbatim, preserved from the original file):
 *
 * Against SYNTHETIC mock-WS sockets only (see synthetic-fleet-support.ts's
 * own ABSOLUTE BOUNDARY doc comment): kill -9 storm takeover, driven through
 * real `createSessionWorker` compositions over real Postgres/Redis. NO real
 * Baileys sockets, NO real WhatsApp numbers, NO real network - measurement
 * against real numbers is explicitly out of scope (P10).
 *
 * TIMING discipline (phase gotcha, verbatim): the storm exercise runs with
 * REAL, uncompressed default `TIMING` (never a fake clock, never a `timing`
 * override on the lease path) - takeover <= 45s is `leaseTtl 30s +
 * takeoverGrace 15s`, proven with real wall-clock waiting. Structure (task's
 * own hint): the storm runs EXACTLY ONCE, in `beforeAll`, shared by the two
 * `it` blocks below that each assert their OWN named property against the
 * captured results - a second storm would double a >45s wall-clock cost for
 * no extra proof.
 *
 * Seeding: this file's OWN tenants/instances only (unique UUIDs per run) -
 * the shared dev DB carries ~51 unrelated seeded `desired_state='online'`,
 * `link_state='linked'` fixture rows (`db/seeds/queue-explain-fixture.sql`)
 * from an EXPLAIN suite, EVERY ONE of them currently unowned/eligible.
 *
 * P09 FLEET-RECOVERY FIX (formerly a real, unavoidable cost - now resolved):
 * `LeaseManager.acquire()` used to `await` the full real `takeoverGraceMs`
 * (15s) INLINE, on every grab whose `instance_lease_state.released_at` was
 * not a fresh, clean release - true for a never-released row regardless of
 * whether it was a first-ever mint or a real takeover. Combined with
 * `discovery.ts`'s own sequential `for (const row of rows)` grab loop, ONE
 * worker taking over N instances used to cost >= N * 15s, and the mandatory
 * <=45s-per-instance SLA was reachable only by spreading the N rows across
 * many small worker-B "replicas" racing concurrently - a harness distortion
 * (production recovers via many ALREADY-RUNNING, independent worker
 * processes, never a synthetic same-process replica pool). The fix moved
 * the grace wait out of `acquire()` (which now returns immediately with
 * `SessionLease.graceMs` set) into a deferred, cancellable wait inside
 * `runner.ts`'s `start()` - composed with the existing U6b wave-connect
 * offset wait - so `discovery.ts`'s grab loop moves to the next row
 * immediately regardless of how long any one instance's grace turns out to
 * be. ONE worker can therefore take over all N instances well within the
 * per-instance 45s SLA (each instance's own clock starts at its own grab,
 * not at the end of some other instance's grace), so this harness now
 * models "worker B" as ONE honest worker (`WORKER_B_COUNT`), never a
 * replica pool.
 *
 * Every assertion besides the fleet-wide connect-bucket rate check is
 * scoped to this file's own instance ids only. A `beforeAll` failure cleans
 * up its own seeded rows before rethrowing (`cleanupEverything`) - a run
 * that fails here must never leave rows behind that would make the NEXT
 * run's noise problem worse.
 */

/**
 * N kept at the task's own "~12 synthetic sessions" figure - the mandatory
 * connect-bucket-rate assertion is stronger with more real connects to
 * bucket, and the fix (see the file-level P09 FLEET-RECOVERY FIX doc
 * comment above) no longer makes N=12 wall-clock-expensive: each grab's
 * lease acquisition (Redis NX + PG fence mint/CAS) is fast, and the grace
 * wait runs deferred/concurrently per instance rather than serializing the
 * discovery loop, so ONE worker converges over the shared dev DB's noise
 * pool in ordinary discovery-tick time, not O(N) * 15s.
 */
const N = 12;
/** Fleet rate floor at this fleet size (`computeConnectRatePerSec`'s own RATE_FLOOR) - bucket capacity == rate, the ceiling the conservation identity below is checked against. */
const FLEET_RATE_FLOOR = 8;
/**
 * The takeover POLLING LOOP's own outer wall-clock ceiling - NOT the
 * mandatory per-instance SLA itself (that is asserted directly, per
 * instance, at <=45_000ms in the named test below). Sized larger than 45s:
 * once worker A dies, its held rows (mine AND every incidental unrelated
 * fixture row it grabbed) all go stale together after the SAME 45s
 * discovery-staleness window - worker B therefore momentarily competes
 * against the FULL unrelated-fixture pool again (not just this file's own
 * 12 rows) until that noise is regrabbed/depleted a second time, same as
 * worker A's own setup phase experienced. This outer ceiling only bounds
 * how long the TEST keeps polling and observing; a result where every one
 * of this file's own instances individually still lands within its own
 * <=45s window is what the named test actually checks.
 */
const STORM_BUDGET_MS = 120_000;
/**
 * Worker A's own setup phase (seeding N rows, then discovering/grabbing
 * every one of them from a cold start against the shared dev DB's
 * unrelated-fixture noise pool) - generous but no longer needs the
 * multi-minute budget the pre-fix serialized grace cost required, since
 * each grab's lease acquisition is fast and the grace wait no longer blocks
 * the next row.
 */
const WORKER_A_SETUP_BUDGET_MS = 180_000;
/** Worker B is ONE honest worker (see the file-level P09 FLEET-RECOVERY FIX doc comment) - production recovers via many already-running, independent worker processes, never an in-test replica pool standing in for the fix. */
const WORKER_B_COUNT = 1;

describe('fleet recovery harness - kill -9 storm, connect-bucket conformance', () => {
  let handles: SyntheticFleetHandles;
  const seededClientIds: string[] = [];
  const seededInstanceIds: string[] = [];
  const seededJobIds: string[] = [];

  // ---------------------------------------------------------------------
  // The kill -9 storm: run ONCE in beforeAll, shared by the two named
  // tests below (task's own structure hint).
  // ---------------------------------------------------------------------

  let workerA: SyntheticWorkerHandle;
  /**
   * "Worker B" is ONE honest worker (`WORKER_B_COUNT`), not a replica pool -
   * see the file-level P09 FLEET-RECOVERY FIX doc comment for why the
   * pre-fix version needed a pool and why the fix removed that need. Kept
   * as an array (length 1) so the rest of this file's loop/cleanup
   * machinery (`Promise.all`, `cleanupEverything`) needs no further
   * restructuring beyond the count itself.
   */
  let workerBReplicas: SyntheticWorkerHandle[];
  let stormResult: StormSetupResult;
  let fenceRegressionBefore: number;
  let fenceRegressionAfter: number;
  /** Fleet connect-bucket conservation bracket (2026-09-02 fix - see `fleet-recovery-bucket-conservation.ts`); `bucketKey` is the same real Redis key every `createSyntheticWorker` here shares (`env: 'test'`), spanning worker A's setup grabs AND worker B's takeover grabs. */
  const bucketKey = sysKey('test', 'sys', 'tb', 'connect');
  let bucketBracket: BucketBracket;
  let bucketAfterMs: number;
  let bucketAfterTokens: number;

  /**
   * Best-effort cleanup shared by `afterAll` AND a `beforeAll` catch-block
   * below: a `beforeAll` throw skips vitest's own `afterAll` entirely,
   * which - without this - would leave this run's seeded rows permanently
   * polluting the shared dev DB's discoverable pool, making every SUBSEQUENT
   * attempt strictly noisier (this is exactly what happened during this
   * dispatch's own debugging: a run that failed here left 25 leftover
   * `fleet-recovery-probe` clients sitting in `wp_lease_scan_unowned`'s own
   * result set, compounding the very noise problem this file's DEVIATION
   * doc comment describes).
   */
  async function cleanupEverything(replicas: SyntheticWorkerHandle[]): Promise<void> {
    for (const replica of replicas) {
      await replica.drain();
    }
    if (seededJobIds.length > 0) {
      await handles.pool.query('DELETE FROM message_jobs WHERE id = ANY($1::bigint[])', [
        seededJobIds,
      ]);
    }
    await cleanupAuthStoreProbeClients(handles.pool, seededClientIds);
    if (seededInstanceIds.length > 0) {
      await handles.pool.query(
        'DELETE FROM instance_lease_state WHERE instance_id = ANY($1::uuid[])',
        [seededInstanceIds],
      );
    }
    const leaseKeys = await handles.redisCtl.keys(`${sysKey('test')}*:lease:i:*`);
    if (leaseKeys.length > 0) {
      await handles.redisCtl.del(...leaseKeys);
    }
  }

  beforeAll(
    async () => {
      handles = createSyntheticFleetHandles();
      bindLeaseMetrics(metrics);
      fenceRegressionBefore = await readCounterValue('wp_fence_regression_total');
      workerBReplicas = [];

      try {
        bucketBracket = await snapshotBucketBefore(handles.redisCtl, bucketKey, FLEET_RATE_FLOOR);
        stormResult = await runStormSetup({
          handles,
          n: N,
          scanRowsPerCycle: SCAN_ROWS_PER_CYCLE,
          sessionCapHeadroom: SESSION_CAP_HEADROOM,
          workerASetupBudgetMs: WORKER_A_SETUP_BUDGET_MS,
          stormBudgetMs: STORM_BUDGET_MS,
          workerBCount: WORKER_B_COUNT,
          seededClientIds,
          seededInstanceIds,
          seededJobIds,
        });
        bucketAfterTokens = (await readBucket(handles.redisCtl, bucketKey)).tokens;
        bucketAfterMs = await redisNowMs(handles.redisCtl);
        workerA = stormResult.workerA;
        workerBReplicas = stormResult.workerBReplicas;
        fenceRegressionAfter = await readCounterValue('wp_fence_regression_total');
      } catch (err) {
        // Row/lease/job cleanup only - `afterAll` still runs even when
        // `beforeAll` throws (vitest's own semantics) and owns disposing
        // `handles.pool`/`handles.redis*` exactly once; disposing them here
        // too would race afterAll's own `handles.pool.query` calls against an
        // already-ended pool.
        await cleanupEverything(workerBReplicas);
        throw err;
      }
    },
    WORKER_A_SETUP_BUDGET_MS + STORM_BUDGET_MS + 30_000,
  );

  afterAll(async () => {
    // Cleanup EVERYTHING seeded by this file, including every "worker B"
    // replica's own live sessions via its real drain path (task
    // requirement).
    await cleanupEverything(workerBReplicas);
    await disposeSyntheticFleetHandles(handles);
  });

  it('kill_dash_9_storm_reconnects_within_bucket_rate', () => {
    const { stormInstanceIds, perInstanceTakeoverMs, openTimestampsDuringStorm } = stormResult;

    // EVERY instance re-owned by a "worker B" replica within <=45s of A's
    // death (measured from kill to acquisition, real timers).
    for (const instanceId of stormInstanceIds) {
      const took = perInstanceTakeoverMs.get(instanceId);
      expect(
        took,
        `instance ${instanceId} was never taken over by a worker B replica`,
      ).toBeDefined();
      expect(took ?? Infinity).toBeLessThanOrEqual(45_000);
    }

    // Connect-bucket conformance (2026-09-02 fix, replacing a wall-clock-
    // windowed bin sample - see `fleet-recovery-bucket-conservation.ts` for
    // the full rationale: that old assertion was a SAMPLED race outcome,
    // observed failing under full-suite load, `expected 9 <= 8`, while
    // passing standalone). Every socket this harness's counting factory
    // builds corresponds to exactly one successful `fleetBucket.take()`, so
    // `openTimestampsDuringStorm.length` IS the exact token spend across
    // this bracket (worker A's setup grabs plus worker B's takeover grabs,
    // the SAME shared `env: 'test'` bucket).
    expect(openTimestampsDuringStorm.length).toBeGreaterThan(0);
    const ceiling = maxTokensAvailable(bucketBracket, bucketAfterMs, FLEET_RATE_FLOOR);
    expect(openTimestampsDuringStorm.length).toBeLessThanOrEqual(Math.floor(ceiling + 1e-9));

    // Range sanity only (not an exact ledger identity - this exercise spends
    // slowly against a bucket that repeatedly re-saturates to capacity,
    // which loses the information an exact identity would need, unlike
    // e3-edge's near-drained race).
    expect(bucketAfterTokens).toBeGreaterThanOrEqual(0);
    expect(bucketAfterTokens).toBeLessThanOrEqual(FLEET_RATE_FLOOR);
  });

  it('takeover_does_not_regress_the_fence', async () => {
    const { stormInstanceIds, fenceSamplesByInstance, stormOwnerWorkerIds } = stormResult;

    expect(fenceRegressionAfter - fenceRegressionBefore).toBe(0);

    // Ownership genuinely moved to ONE of the worker B replicas (a NEW
    // owner, never worker A) for each instance.
    const ownerRows = await handles.pool.query<{ instance_id: string; owner_worker_id: string }>(
      'SELECT instance_id, owner_worker_id FROM instance_lease_state WHERE instance_id = ANY($1::uuid[])',
      [stormInstanceIds],
    );
    for (const row of ownerRows.rows) {
      expect(stormOwnerWorkerIds.has(row.owner_worker_id)).toBe(true);
      expect(row.owner_worker_id).not.toBe(workerA.workerId);
    }

    // For each of our instances, the sampled fence sequence (before kill /
    // after takeover) is strictly increasing.
    for (const [instanceId, samples] of fenceSamplesByInstance) {
      for (let i = 1; i < samples.length; i += 1) {
        expect(
          samples[i]! > samples[i - 1]!,
          `fence regressed for instance ${instanceId}: ${String(samples)}`,
        ).toBe(true);
      }
    }
  });
});
