import { createPool, createTenantDb, type TenantDb, type TenantQueryable } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { seedWaGroup, readWaGroupState, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import type { GroupSocketPort } from './sync.js';
import { createSessionRegistry, type RunnerHandle } from '../../engine/session/registry.js';
import { buildGroupsSyncTimer } from '../../engine/session/session-groups-sync-timer.js';

/**
 * groups-sync-timer-c2b.integration.test.ts (P24 C1 round-2 fix, WARNING 3) -
 * sibling of `groups-sync-timer-c2.integration.test.ts` (kept separate purely
 * for that file's own line budget): the LEAVE-SWEEP pass's per-handle
 * isolation. `session-groups-sync-timer.ts`'s `runOnce` previously awaited
 * `runPendingGroupLeaves` per handle with no per-handle try/catch, so one
 * tenant's DB error inside `listPendingLeaves` (outside `sync-worker.ts`'s own
 * per-row try/catch) aborted the leave sweep for every remaining owned
 * instance. This asserts the fix: instance B's pending leave still executes
 * and is marked left in the same tick as instance A's failing leave query.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-timer-c2b-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function buildFakeHandle(
  clientId: string,
  instanceId: string,
  groupSocket: GroupSocketPort,
): RunnerHandle {
  return {
    instanceId,
    clientId,
    end: () => undefined,
    teardownNoRelease: async () => undefined,
    teardownWithRelease: async () => undefined,
    getGroupSocket: () => groupSocket,
  };
}

/** Delegates to the real `tenantDb`, except rejecting every `withTenant` call for `failingClientId` - simulates `listPendingLeaves`'s DB error, which sits OUTSIDE `sync-worker.ts`'s own per-row try/catch. */
function tenantDbFailingFor(real: TenantDb, failingClientId: string): TenantDb {
  return {
    withTenant<T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>): Promise<T> {
      if (clientId === failingClientId) {
        return Promise.reject(new Error('simulated listPendingLeaves DB failure'));
      }
      return real.withTenant(clientId, fn);
    },
  };
}

describe('groups sync timer - a failing leave query on one instance does not abort the sweep for others', () => {
  it('a_failing_leave_query_on_one_instance_does_not_abort_the_sweep_for_others', async () => {
    const tenantA = await seedPacingInstance(pool, probeClientIds, {});
    const tenantB = await seedPacingInstance(pool, probeClientIds, {});
    const groupA = await seedWaGroup(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      leaveRequestedAt: new Date(),
    });
    const groupB = await seedWaGroup(pool, {
      clientId: tenantB.clientId,
      instanceId: tenantB.instanceId,
      leaveRequestedAt: new Date(),
    });

    const noopSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => ({}),
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };

    const registry = createSessionRegistry();
    registry.set(
      tenantA.instanceId,
      buildFakeHandle(tenantA.clientId, tenantA.instanceId, noopSocket),
    );
    registry.set(
      tenantB.instanceId,
      buildFakeHandle(tenantB.clientId, tenantB.instanceId, noopSocket),
    );

    const warnLines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const timer = buildGroupsSyncTimer({
      tenantDb: tenantDbFailingFor(tenantDb, tenantA.clientId),
      registry,
      logger: {
        warn: (obj, msg) => warnLines.push({ obj, msg }),
        info: () => undefined,
      },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await expect(timer.runOnce()).resolves.toBeUndefined();
    } finally {
      timer.stop();
    }

    const stateA = await readWaGroupState(pool, groupA.id);
    expect(stateA?.left_at).toBeNull();
    const stateB = await readWaGroupState(pool, groupB.id);
    expect(stateB?.left_at).not.toBeNull();

    expect(
      warnLines.some(
        (line) =>
          line.msg === 'groups: leave sweep failed for instance' &&
          line.obj.instance_id === tenantA.instanceId &&
          line.obj.client_id === tenantA.clientId,
      ),
    ).toBe(true);
  });
});
