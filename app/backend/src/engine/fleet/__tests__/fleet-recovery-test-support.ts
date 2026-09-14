import { randomUUID } from 'node:crypto';
import { metrics } from '@wp/server-kit';
import { buildStore } from '../../../provider/baileys/auth-state/__tests__/store-fixtures.js';
import {
  createCountingSocketFactory,
  createSyntheticWorker,
  mintBoundedOffsetInstanceId,
  type SyntheticFleetHandles,
  type SyntheticWorkerHandle,
} from '../../session/synthetic-fleet-support.js';

/**
 * fleet-recovery-test-support.ts (FIX-P09-B split) - shared seeding/metrics
 * helpers for `fleet-recovery.integration.test.ts`'s split files
 * (`fleet-recovery-storm.integration.test.ts` and
 * `fleet-recovery-rolling-restart.integration.test.ts`), mechanically
 * extracted at FIX-P09-B for the max-lines cap. No logic change - same
 * helpers, same behavior.
 *
 * Lives under `__tests__/` so the tenant-scope guard's own test-path
 * exemption covers its seed INSERTs - see
 * `discovery-integration-test-support.ts`'s own doc comment for the exact
 * convention this follows.
 */

export const SCAN_ROWS_PER_CYCLE = 24;
/** Generous per-worker session cap - well above `N` so an incidental grab of an unrelated seeded fixture row never exhausts a worker's OWN capacity before it can reach every one of this file's own rows (see the worker A setup comment below). */
export const SESSION_CAP_HEADROOM = 100;

export interface SeededInstance {
  clientId: string;
  instanceId: string;
}

export async function readCounterValue(metricLine: string): Promise<number> {
  const text = await metrics.metricsText();
  const found = text.split('\n').find((l) => l.startsWith(metricLine) && !l.startsWith('#'));
  if (!found) return 0;
  const value = found.split(' ').at(-1);
  return value ? Number(value) : 0;
}

/**
 * Seeds one linked instance + placeholder lease row + real encrypted creds +
 * one queued message_jobs row - the shared fixture shape both the storm and
 * rolling-restart exercises use. `seededJobIds`/`seededClientIds`/
 * `seededInstanceIds` are the caller's own accumulator arrays (mutated here)
 * so its own `cleanupEverything`/`afterAll` sees every row this seeds.
 */
export async function seedLinkedInstance(
  handles: SyntheticFleetHandles,
  seededClientIds: string[],
  seededInstanceIds: string[],
  seededJobIds: string[],
): Promise<SeededInstance> {
  const clientId = randomUUID();
  const instanceId = mintBoundedOffsetInstanceId();

  await handles.pool.query(
    'INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)',
    [clientId, 'Fleet Recovery Probe', `fleet-recovery-probe-${clientId}`, 'active'],
  );
  await handles.pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, link_state, desired_state, session_epoch)
     VALUES ($1, $2, 'probe', 'connected', 'linked', 'online', 0)`,
    [instanceId, clientId],
  );
  seededClientIds.push(clientId);
  seededInstanceIds.push(instanceId);

  // A placeholder `instance_lease_state` row at fence 1, "owned" by a
  // throwaway seed worker id, is the precondition `session-creds-
  // upsert.sql`'s fence-EXISTS subquery requires (`ls.current_fence =
  // $fence AND ls.owner_worker_id = $worker_id`) - a `buildStore` call
  // with no lease row at all always misses as `fence_conflict` (see
  // `session-creds-classify-miss.sql`'s own doc comment: NULL current_fence
  // classifies as a fence conflict). This placeholder row is immediately
  // superseded by the real worker's own `LeaseManager.acquire` mint - it
  // exists ONLY to satisfy this precondition at seed time, exactly the
  // same "seed a lease row first" precondition
  // `drain.integration.test.ts`'s `acquireRealLease` establishes via a
  // real LeaseManager instead of a raw INSERT.
  // `lease_seen_at` is left NULL (never `now()`) - `wp_lease_scan_unowned`'s
  // own eligibility predicate is `lease_seen_at IS NULL OR lease_seen_at <
  // now() - interval '45 seconds'`; a fresh `now()` here would make this
  // seed row look like a CURRENTLY-live lease and block the first real
  // worker from discovering/grabbing it at all.
  const seedWorkerId = 'worker-fleet-recovery-seed';
  await handles.pool.query(
    `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
     VALUES ($1, $2, 1, $3, NULL)`,
    [instanceId, clientId, seedWorkerId],
  );

  // Real encrypted creds so takeover/restart resumes from creds (zero
  // re-QR is provable) - same P07 store-fixtures precedent
  // drain.integration.test.ts uses.
  const store = buildStore(handles, { instanceId, clientId, fence: 1n, workerId: seedWorkerId });
  await store.saveCreds({ creds: { seeded: true }, expectedVersion: 0n, fence: 1n });

  // A handful of message_jobs rows per instance (P03 queue seeding
  // precedent) to prove zero-lost/zero-unresolved across the exercise.
  const jobResult = await handles.pool.query<{ id: string }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
     RETURNING id`,
    [
      clientId,
      instanceId,
      `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      JSON.stringify({ text: 'fleet-recovery-probe' }),
    ],
  );
  const jobId = jobResult.rows[0]?.id;
  if (jobId) seededJobIds.push(jobId);

  return { clientId, instanceId };
}

export async function readFenceOnce(
  handles: SyntheticFleetHandles,
  instanceId: string,
): Promise<bigint | undefined> {
  const result = await handles.pool.query<{ current_fence: string }>(
    'SELECT current_fence FROM instance_lease_state WHERE instance_id = $1',
    [instanceId],
  );
  const row = result.rows[0];
  return row ? BigInt(row.current_fence) : undefined;
}

export interface StormSetupResult {
  workerA: SyntheticWorkerHandle;
  workerBReplicas: SyntheticWorkerHandle[];
  stormInstanceIds: string[];
  openTimestampsDuringStorm: number[];
  perInstanceTakeoverMs: Map<string, number>;
  fenceSamplesByInstance: Map<string, bigint[]>;
  stormOwnerWorkerIds: Set<string>;
}

/**
 * Runs the kill -9 storm's own setup + takeover sequence, mechanically
 * extracted out of `fleet-recovery-storm.integration.test.ts`'s `beforeAll`
 * at FIX-P09-B for the max-lines cap (pure code motion - explicit
 * parameters replace closed-over module state; every value the two named
 * tests assert against is returned on `StormSetupResult` instead of being
 * written to shared `let`s). No logic change.
 */
export async function runStormSetup(input: {
  handles: SyntheticFleetHandles;
  n: number;
  scanRowsPerCycle: number;
  sessionCapHeadroom: number;
  workerASetupBudgetMs: number;
  stormBudgetMs: number;
  workerBCount: number;
  seededClientIds: string[];
  seededInstanceIds: string[];
  seededJobIds: string[];
}): Promise<StormSetupResult> {
  const { handles, n, scanRowsPerCycle, sessionCapHeadroom, workerBCount } = input;

  const seeded: SeededInstance[] = [];
  for (let i = 0; i < n; i += 1) {
    seeded.push(
      await seedLinkedInstance(
        handles,
        input.seededClientIds,
        input.seededInstanceIds,
        input.seededJobIds,
      ),
    );
  }
  const stormInstanceIds = seeded.map((s) => s.instanceId);

  const counting = createCountingSocketFactory({ openAfterMs: 5 });

  // Worker A: a single worker holding all N instances up front. Each
  // grab's lease acquisition (Redis NX + PG fence mint/CAS) is fast - the
  // real `takeoverGraceMs` this instance's own first-ever mint incurs
  // (`instance_lease_state.released_at` is NULL for a never-released row,
  // so `LeaseManager.acquire`'s grace step never skips) runs deferred,
  // concurrently, inside `runner.ts`'s `start()` (P09 FLEET-RECOVERY FIX)
  // - it no longer blocks `discovery.ts`'s grab loop from moving to the
  // next row.
  //
  // `sessionCap` is deliberately GENEROUS here (`sessionCapHeadroom`,
  // well above N) rather than pinned to N: `discovery.ts`'s own
  // `remainingCapacity = getCap() - getCurrentSessions()` is a LIVE
  // registry-size check re-evaluated every cycle - a cap pinned to exactly
  // N stops ALL further grabs (including this file's own remaining rows)
  // the moment the ~54 unrelated fixture rows' `ORDER BY random()` draw
  // fills that many slots with OTHER instances first. `maxScanRows` stays
  // small (`scanRowsPerCycle`) to bound each cycle's worst case, and the
  // loop below is wall-clock-bounded (never iteration-count-bounded) so it
  // keeps polling until every one of this file's own rows lands.
  const workerA = createSyntheticWorker({
    handles,
    workerId: `worker-fleet-a-${randomUUID()}`,
    socketFactory: counting.factory,
    maxScanRows: scanRowsPerCycle,
    sessionCap: sessionCapHeadroom,
  });
  function ownedCountA(): number {
    return stormInstanceIds.filter((id) => workerA.worker.registry.has(id)).length;
  }
  const setupDeadline = Date.now() + input.workerASetupBudgetMs;
  while (Date.now() < setupDeadline && ownedCountA() < n) {
    await workerA.runOneScanIteration();
  }
  for (const instanceId of stormInstanceIds) {
    if (!workerA.worker.registry.has(instanceId)) {
      throw new Error(`setup failed: worker A never acquired instance ${instanceId}`);
    }
  }

  const fenceSamplesByInstance = new Map<string, bigint[]>();
  for (const instanceId of stormInstanceIds) {
    const fence = await readFenceOnce(handles, instanceId);
    fenceSamplesByInstance.set(instanceId, fence !== undefined ? [fence] : []);
  }

  // kill -9 worker A: hard-stop, never releases leases, never drains.
  const killedAt = Date.now();
  await workerA.kill9();

  // Worker B (already running, discovery active) takes over EVERY
  // instance. P09 FLEET-RECOVERY FIX: `discovery.ts`'s grab loop moves to
  // the next row immediately regardless of any one instance's takeover
  // grace (the grace now runs deferred/concurrently inside `runner.ts`'s
  // `start()`, never inline inside `LeaseManager.acquire()`) - so ONE
  // worker can take over all N instances well within the mandatory
  // <=45s-per-instance SLA (each instance's own 45s clock starts at ITS
  // OWN grab, not at the end of some other instance's grace). This
  // harness therefore models "worker B" as `workerBCount` (1) honest
  // worker - never a same-process replica pool standing in for the fix -
  // exactly the real production shape at small scale: one already-running
  // worker process discovers and grabs every orphaned row via the SAME
  // `LeaseManager.acquire` NX-then-fence exclusivity every real worker
  // uses, never a shortcut, never compressed TIMING.
  const workerBReplicas = Array.from({ length: workerBCount }, (_, i) =>
    createSyntheticWorker({
      handles,
      workerId: `worker-fleet-b-${i}-${randomUUID()}`,
      socketFactory: counting.factory,
      maxScanRows: scanRowsPerCycle,
      sessionCap: sessionCapHeadroom,
    }),
  );
  const stormOwnerWorkerIds = new Set(workerBReplicas.map((w) => w.workerId));

  const perInstanceTakeoverMs = new Map<string, number>();
  const deadline = killedAt + input.stormBudgetMs;

  function isOwnedByAnyReplica(instanceId: string): boolean {
    return workerBReplicas.some((w) => w.worker.registry.has(instanceId));
  }

  while (Date.now() < deadline && perInstanceTakeoverMs.size < stormInstanceIds.length) {
    // Every worker runs its own scan cycle CONCURRENTLY (real production
    // shape: independent worker processes never block on each other) -
    // `LeaseManager.acquire`'s Redis NX step is still the sole arbiter of
    // who actually wins each row. `workerBCount` is 1 today, but the
    // loop stays shape-generic (`Promise.all` over the array) rather than
    // hardcoding a single-worker call, so a future test could widen the
    // pool without restructuring this loop.
    await Promise.all(workerBReplicas.map((w) => w.runOneScanIteration()));

    for (const instanceId of stormInstanceIds) {
      if (perInstanceTakeoverMs.has(instanceId)) continue;
      if (isOwnedByAnyReplica(instanceId)) {
        perInstanceTakeoverMs.set(instanceId, Date.now() - killedAt);
        const fence = await readFenceOnce(handles, instanceId);
        if (fence !== undefined) {
          fenceSamplesByInstance.get(instanceId)?.push(fence);
        }
      }
    }

    if (perInstanceTakeoverMs.size < stormInstanceIds.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return {
    workerA,
    workerBReplicas,
    stormInstanceIds,
    openTimestampsDuringStorm: counting.allOpenTimestamps(),
    perInstanceTakeoverMs,
    fenceSamplesByInstance,
    stormOwnerWorkerIds,
  };
}
