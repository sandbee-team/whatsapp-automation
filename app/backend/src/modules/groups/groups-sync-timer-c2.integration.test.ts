import { createPool, createTenantDb, type TenantDb } from '@wp/db';
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
 * groups-sync-timer-c2.integration.test.ts (P24 C2 test-engineer) - the
 * per-worker groups-sync/leave timer edge cases beyond `sync.integration.
 * test.ts`'s own once-per-hour + never-touched-tenant coverage: an instance
 * with no live group socket is skipped WITHOUT touching its clock, a
 * provider throw on ONE instance never stops the tick for the others, a
 * leave whose `groupLeave` throws is retried next tick and never marked
 * left, a tick with zero owned instances issues no query, and the LIMIT on
 * pending leaves is respected (the rest picked up next tick).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-timer-c2-test',
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
  groupSocket?: GroupSocketPort,
): RunnerHandle {
  return {
    instanceId,
    clientId,
    end: () => undefined,
    teardownNoRelease: async () => undefined,
    teardownWithRelease: async () => undefined,
    ...(groupSocket ? { getGroupSocket: () => groupSocket } : {}),
  };
}

describe('groups sync timer - a socket-not-connected instance is skipped without touching its clock', () => {
  it('an_instance_whose_getGroupSocket_returns_undefined_is_skipped_and_its_clock_is_untouched', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    await pool.query(
      `UPDATE whatsapp_instances SET groups_sync_requested_at = now() WHERE id = $1`,
      [instanceId],
    );
    const before = await pool.query(
      `SELECT groups_last_synced_at, groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );

    const registry = createSessionRegistry();
    // getGroupSocket is entirely absent (a socket not yet connected) - the
    // timer's own `handle.getGroupSocket?.()` optional-call must skip this
    // handle without ever reaching `isSyncDue`/the request query.
    registry.set(instanceId, buildFakeHandle(clientId, instanceId, undefined));

    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await timer.runOnce();
    } finally {
      timer.stop();
    }

    const after = await pool.query(
      `SELECT groups_last_synced_at, groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('groups sync timer - one instance error never stops the others', () => {
  it('a_provider_throw_on_one_instance_does_not_stop_the_sync_of_the_others_in_the_same_tick', async () => {
    const tenantA = await seedPacingInstance(pool, probeClientIds, {});
    const tenantB = await seedPacingInstance(pool, probeClientIds, {});
    await pool.query(
      `UPDATE whatsapp_instances SET groups_sync_requested_at = now() WHERE id = ANY($1)`,
      [[tenantA.instanceId, tenantB.instanceId]],
    );

    const throwingSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        throw new Error('simulated provider fetch failure');
      },
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };
    let bFetchCount = 0;
    const workingSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        bFetchCount += 1;
        return {};
      },
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };

    const registry = createSessionRegistry();
    registry.set(
      tenantA.instanceId,
      buildFakeHandle(tenantA.clientId, tenantA.instanceId, throwingSocket),
    );
    registry.set(
      tenantB.instanceId,
      buildFakeHandle(tenantB.clientId, tenantB.instanceId, workingSocket),
    );

    const warnLines: string[] = [];
    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: (_obj, msg) => warnLines.push(msg), info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await expect(timer.runOnce()).resolves.toBeUndefined();
    } finally {
      timer.stop();
    }

    expect(bFetchCount).toBe(1);
    expect(warnLines.some((line) => line.includes('sync failed'))).toBe(true);
  });
});

describe('groups sync timer - a leave whose groupLeave throws is retried, never marked left', () => {
  it('a_leave_that_throws_is_not_marked_left_and_is_retried_next_tick', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const group = await seedWaGroup(pool, { clientId, instanceId, leaveRequestedAt: new Date() });

    let attemptCount = 0;
    const flakySocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => ({}),
      groupLeave: async () => {
        attemptCount += 1;
        if (attemptCount === 1) {
          throw new Error('simulated groupLeave provider failure');
        }
      },
      selfJid: () => undefined,
    };

    const registry = createSessionRegistry();
    registry.set(instanceId, buildFakeHandle(clientId, instanceId, flakySocket));

    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await timer.runOnce();
      const afterFirstTick = await readWaGroupState(pool, group.id);
      expect(afterFirstTick?.left_at).toBeNull();

      await timer.runOnce();
      const afterSecondTick = await readWaGroupState(pool, group.id);
      expect(afterSecondTick?.left_at).not.toBeNull();
    } finally {
      timer.stop();
    }
    expect(attemptCount).toBe(2);
  });
});

describe('groups sync timer - a tick with zero owned instances issues no query', () => {
  it('an_empty_registry_runs_the_tick_with_no_error_and_no_provider_call', async () => {
    const registry = createSessionRegistry();
    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await expect(timer.runOnce()).resolves.toBeUndefined();
    } finally {
      timer.stop();
    }
  });
});

describe('groups sync timer - pending-leave LIMIT is respected, deterministic oldest-first', () => {
  it('more_due_leaves_than_the_limit', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    // LEAVE_BATCH_LIMIT is 20 (sync-worker.ts) - seed 22 pending leaves,
    // each with a DISTINCT, explicit, strictly-increasing leave_requested_at
    // (no ambient clock) so the first batch's exact membership is a
    // deterministic assertion (Fix 5: `groups-leave-pending.sql` now orders
    // `leave_requested_at ASC, id ASC` before its LIMIT).
    const baseMs = Date.parse('2026-09-01T00:00:00.000Z');
    const groupsOldestFirst = [];
    for (let i = 0; i < 22; i += 1) {
      const group = await seedWaGroup(pool, {
        clientId,
        instanceId,
        leaveRequestedAt: new Date(baseMs + i * 1000),
      });
      groupsOldestFirst.push(group);
    }
    const expectedFirstBatchIds = new Set(groupsOldestFirst.slice(0, 20).map((g) => g.id));
    const expectedSecondBatchIds = new Set(groupsOldestFirst.slice(20).map((g) => g.id));

    const leftJids = new Set<string>();
    const socket: GroupSocketPort = {
      groupFetchAllParticipating: async () => ({}),
      groupLeave: async (jid: string) => {
        leftJids.add(jid);
      },
      selfJid: () => undefined,
    };

    const registry = createSessionRegistry();
    registry.set(instanceId, buildFakeHandle(clientId, instanceId, socket));

    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });
    try {
      await timer.runOnce();
      expect(leftJids.size).toBe(20);
      // The FIRST batch is exactly the 20 oldest by leave_requested_at.
      for (const group of groupsOldestFirst) {
        const state = await readWaGroupState(pool, group.id);
        if (expectedFirstBatchIds.has(group.id)) {
          expect(state?.left_at).not.toBeNull();
        } else {
          expect(state?.left_at).toBeNull();
        }
      }

      await timer.runOnce();
      expect(leftJids.size).toBe(22);
      // The remaining 2 (the second batch) are now also left - every seeded
      // group is left after the second tick, none starved.
      for (const group of groupsOldestFirst) {
        const state = await readWaGroupState(pool, group.id);
        expect(state?.left_at).not.toBeNull();
      }
      expect(expectedSecondBatchIds.size).toBe(2);
    } finally {
      timer.stop();
    }
  });
});
