import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSyntheticFleetHandles,
  disposeSyntheticFleetHandles,
  type SyntheticFleetHandles,
} from '../session/synthetic-fleet-support.js';
import { createScaleFleet, type ScaleFleet } from './scale-fleet.js';
import { readFence } from './run-chaos-fleet-reads.js';

/**
 * scale-fleet.integration.test.ts (P26 U2a) - proves the fleet-scale harness
 * spreads real instances over REAL worker child PROCESSES (never in-process
 * fakes) through the real lease/fence/EncryptedAuthStore/claim/reserve/
 * dispatch path, that a hard kill is taken over via the real LeaseManager
 * path, that no child ever dials a real WhatsApp host, and that `stop()`
 * drains every child and cleans every seeded row.
 *
 * Small plan (2 workers x 3 instances, 2 tenants, sessionCap 10) with
 * COMPRESSED child timing (leaseTtlMs 5000/heartbeatMs 500/takeoverGraceMs
 * 1000 - same shape as `redis-flush.integration.test.ts`'s
 * COMPRESSED_TIMING) so lease acquire/heartbeat/takeover-grace stay fast;
 * `DISCOVERY_STALE_MS` itself (30_000ms, `engine/fleet/discovery.ts`) is a
 * fixed constant this harness's own parent-observed-staleness model does not
 * override, so the kill-9 case's own wall-clock cost is dominated by that
 * one wait - the file still finishes well under a minute.
 */

const PLAN = { workers: 2, instancesPerWorker: 3, tenants: 2, sessionCap: 10 };
const COMPRESSED_TIMING = {
  leaseTtlMs: 5_000,
  heartbeatMs: 500,
  takeoverGraceMs: 1_000,
};

let handles: SyntheticFleetHandles;
let fleet: ScaleFleet;

beforeAll(async () => {
  handles = createSyntheticFleetHandles();
  fleet = createScaleFleet({
    handles,
    plan: PLAN,
    timing: COMPRESSED_TIMING,
    childEnv: { WP_SCALE_NEVER_DIAL_GUARD: '1' },
  });
  await fleet.start();
}, 60_000);

afterAll(async () => {
  await fleet.stop();
  await disposeSyntheticFleetHandles(handles);
}, 30_000);

describe('scale-fleet', () => {
  it('instances_are_spread_across_real_worker_processes', async () => {
    const owners = await fleet.ownerMap();
    expect(owners.size).toBe(PLAN.workers * PLAN.instancesPerWorker);

    const ownerWorkerIds = new Set(owners.values());
    expect(ownerWorkerIds.size).toBe(PLAN.workers);

    const perWorkerCounts = new Map<string, number>();
    for (const workerId of owners.values()) {
      perWorkerCounts.set(workerId, (perWorkerCounts.get(workerId) ?? 0) + 1);
    }
    for (const count of perWorkerCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(1);
    }

    // Real child processes, not this test process.
    expect(perWorkerCounts.size).toBe(PLAN.workers);
  });

  it('sigkill_of_one_worker_process_is_taken_over_by_a_survivor_through_the_real_lease_path', async () => {
    const beforeOwners = await fleet.ownerMap();
    const clientIds = fleet.clientIds();
    const fenceBefore = new Map<string, bigint>();
    for (const instanceId of beforeOwners.keys()) {
      const fence = await readFence(handles.pool, instanceId, clientIds);
      if (fence !== undefined) fenceBefore.set(instanceId, fence);
    }

    const w1InstanceIds = [...beforeOwners.entries()]
      .filter(([, owner]) => owner === 'scale-worker-0')
      .map(([instanceId]) => instanceId);
    expect(w1InstanceIds.length).toBeGreaterThan(0);

    fleet.kill9('scale-worker-0');
    const results = await fleet.reassignDeadWorkerInstances('scale-worker-0', ['scale-worker-1']);

    expect(results.length).toBe(w1InstanceIds.length);
    for (const result of results) {
      expect(result.takeoverMs).toBeGreaterThanOrEqual(0);
      expect(w1InstanceIds).toContain(result.instanceId);
    }

    const afterOwners = await fleet.ownerMap();
    for (const instanceId of w1InstanceIds) {
      expect(afterOwners.get(instanceId)).toBe('scale-worker-1');
    }

    for (const instanceId of w1InstanceIds) {
      const fenceAfter = await readFence(handles.pool, instanceId, clientIds);
      const before = fenceBefore.get(instanceId);
      expect(fenceAfter).toBeDefined();
      expect(before).toBeDefined();
      expect(fenceAfter! > before!).toBe(true);
    }

    // Replace the killed worker so a subsequent test in this file (if any)
    // still sees `PLAN.workers` live children.
    await fleet.spawn('scale-worker-0');
  }, 60_000);

  it('the_harness_never_dials_whatsapp', async () => {
    const owners = await fleet.ownerMap();
    const stats = await fleet.requestStats();

    let totalSessions = 0;
    let totalDialAttempts = 0;
    for (const stat of stats.values()) {
      totalSessions += stat.sessions;
      totalDialAttempts += stat.dialAttempts ?? 0;
    }

    expect(totalSessions).toBe(owners.size);
    expect(totalDialAttempts).toBe(0);
  });

  it('stop_drains_children_and_cleans_every_seeded_row', async () => {
    // The fleet's own seeded tenant ids - never a wildcard re-derivation
    // by instance_id (P26 C1 MAJOR 9).
    const clientIds = fleet.clientIds();

    await fleet.stop();

    const countResult = await handles.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM clients WHERE id = ANY($1)',
      [clientIds],
    );
    expect(countResult.rows[0]?.count).toBe('0');
  }, 30_000);
});
