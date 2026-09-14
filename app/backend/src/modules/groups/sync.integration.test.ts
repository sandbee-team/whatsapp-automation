import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import type { GroupSocketPort } from './sync.js';
import { createSessionRegistry, type RunnerHandle } from '../../engine/session/registry.js';
import { buildGroupsSyncTimer } from '../../engine/session/session-groups-sync-timer.js';

/**
 * sync.integration.test.ts (P24 Unit U3, step 4/5) - real Postgres, a fake
 * group socket (call counters, no real Baileys). Proves the once-per-hour
 * sync gate (via the real `buildGroupsSyncTimer` due-check - the timer is
 * the gate, `runGroupSyncForInstance` itself is not) and that an instance
 * whose tenant never touched groups is never synced. The "counts only,
 * never a participant identity" and "pending leaves" proofs live in the
 * sibling `sync-counts.integration.test.ts` (split for this file's
 * max-lines cap).
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-test',
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

describe('group sync - once-per-hour gate', () => {
  it('group_sync_runs_at_most_once_per_hour_per_instance', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    await pool.query(
      `UPDATE whatsapp_instances SET groups_sync_requested_at = now() WHERE id = $1`,
      [instanceId],
    );

    let fetchCount = 0;
    const groupSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        fetchCount += 1;
        return {};
      },
      groupLeave: async () => undefined,
      selfJid: () => 'self@s.whatsapp.net',
    };

    const registry = createSessionRegistry();
    registry.set(instanceId, buildFakeHandle(clientId, instanceId, groupSocket));

    const timer = buildGroupsSyncTimer({
      tenantDb,
      registry,
      logger: { warn: () => undefined, info: () => undefined },
      intervalMs: 3_600_000,
      jitterMs: 0,
    });

    try {
      await timer.runOnce();
      expect(fetchCount).toBe(1);
      const afterFirst = await pool.query<{ groups_next_sync_after: Date }>(
        `SELECT groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
        [instanceId],
      );
      expect(afterFirst.rows[0]?.groups_next_sync_after).toBeInstanceOf(Date);

      // Advance 59 minutes: re-request a sync, but the sync clock has not elapsed.
      await pool.query(
        `UPDATE whatsapp_instances SET groups_sync_requested_at = now(),
           groups_next_sync_after = now() + interval '1 minute'
          WHERE id = $1`,
        [instanceId],
      );
      const beforeRow = await pool.query(
        `SELECT groups_last_synced_at, updated_at FROM whatsapp_instances WHERE id = $1`,
        [instanceId],
      );
      await timer.runOnce();
      expect(fetchCount).toBe(1);
      const afterSecond = await pool.query(
        `SELECT groups_last_synced_at, updated_at FROM whatsapp_instances WHERE id = $1`,
        [instanceId],
      );
      expect(afterSecond.rows[0]).toEqual(beforeRow.rows[0]);

      // Advance to 61 minutes: the clock has elapsed - one more call.
      await pool.query(
        `UPDATE whatsapp_instances SET groups_next_sync_after = now() - interval '1 minute' WHERE id = $1`,
        [instanceId],
      );
      await timer.runOnce();
      expect(fetchCount).toBe(2);
    } finally {
      timer.stop();
    }
  });
});

describe('group sync - an untouched tenant is never synced', () => {
  it('an_instance_whose_tenant_never_touched_groups_is_never_synced', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});

    let fetchCount = 0;
    const groupSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => {
        fetchCount += 1;
        return {};
      },
      groupLeave: async () => undefined,
      selfJid: () => undefined,
    };
    const registry = createSessionRegistry();
    registry.set(instanceId, buildFakeHandle(clientId, instanceId, groupSocket));

    const before = await pool.query(
      `SELECT groups_last_synced_at, groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );

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

    expect(fetchCount).toBe(0);
    const after = await pool.query(
      `SELECT groups_last_synced_at, groups_next_sync_after FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
