import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { metrics as defaultMetrics } from '@wp/server-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { seedWaGroup, readWaGroupState, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { runGroupSyncForInstance, type GroupSocketPort } from './sync.js';
import { runPendingGroupLeaves } from './sync-worker.js';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';

/**
 * sync-counts.integration.test.ts (P24 Unit U3, step 4/5) - split out of
 * `sync.integration.test.ts` for that file's max-lines cap (same split
 * idiom as `queue-send-tenant-fixture.ts`). Proves: `runGroupSyncForInstance`
 * persists counts only and never leaks a participant identity into any
 * column/log/metric, a missing-from-refetch group is marked left, an upsert
 * never touches `send_enabled`, and `runPendingGroupLeaves` executes each
 * pending leave exactly once.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-counts-test',
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

type FetchedGroups = Awaited<ReturnType<GroupSocketPort['groupFetchAllParticipating']>>;
type FetchedGroupInput = {
  participants: FetchedGroups[string]['participants'];
  announce?: boolean;
};

function fakeSocket(
  groups: Record<string, FetchedGroupInput>,
  selfJid: string | undefined,
): { socket: GroupSocketPort } {
  const socket: GroupSocketPort = {
    groupFetchAllParticipating: async () => {
      const result: FetchedGroups = {};
      for (const [jid, g] of Object.entries(groups)) {
        result[jid] = { id: jid, participants: g.participants, announce: g.announce };
      }
      return result;
    },
    groupLeave: async () => undefined,
    selfJid: () => selfJid,
  };
  return { socket };
}

describe('group sync - counts only, never a participant identity', () => {
  it('sync_persists_counts_and_never_a_participant_identity', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const participantJidPrefix = '9199000000';
    const participants = Array.from({ length: 184 }, (_, i) => ({
      id: `${participantJidPrefix}${String(i).padStart(3, '0')}@s.whatsapp.net`,
      admin: i === 0 ? ('admin' as const) : null,
    }));
    const selfJid = participants[0]!.id;
    const groupJid = '120363000000000001@g.us';

    const logLines: string[] = [];
    const { socket } = fakeSocket({ [groupJid]: { participants } }, selfJid);

    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: socket,
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: {
        warn: (obj, msg) => logLines.push(`${msg} ${JSON.stringify(obj)}`),
        // The success line now logs at info (P24 C1 fix, Finding 4) - spied
        // the same way so this test still verifies the logged content, not
        // just a warn call that no longer happens on the success path.
        info: (obj, msg) => logLines.push(`${msg} ${JSON.stringify(obj)}`),
      },
    });

    const rows = await pool.query<{ id: string; group_jid: string }>(
      `SELECT id, group_jid FROM wa_groups WHERE client_id = $1 AND instance_id = $2`,
      [clientId, instanceId],
    );
    expect(rows.rows).toHaveLength(1);
    const groupId = rows.rows[0]!.id;
    const state = await readWaGroupState(pool, groupId);
    expect(state?.participant_count).toBe(184);
    expect(state?.tracked_participant_devices).toBe(368);

    const fullRowText = JSON.stringify(rows.rows[0]);
    expect(fullRowText).not.toContain(participantJidPrefix);
    for (const line of logLines) {
      expect(line).not.toContain(participantJidPrefix);
    }
    const metricsText = await defaultMetrics.metricsText();
    expect(metricsText).not.toContain(participantJidPrefix);

    // A group missing from a SECOND, NON-EMPTY fetch is marked left (P24 C2
    // fix round, Fix 3: an EMPTY fetched map is treated as "no data this
    // tick" and marks nothing left - see `groups-upsert-mark-left-c2.
    // integration.test.ts`'s own PINNED case for that behaviour; this fetch
    // is deliberately non-empty, containing an UNRELATED group, so it still
    // exercises the genuine "missing from a real refetch" semantics).
    const otherGroupJid = '120363000000099999@g.us';
    const { socket: refetchSocket } = fakeSocket(
      { [otherGroupJid]: { participants: [{ id: selfJid }] } },
      selfJid,
    );
    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: refetchSocket,
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });
    const afterMissing = await readWaGroupState(pool, groupId);
    expect(afterMissing?.left_at).not.toBeNull();
    expect(afterMissing?.send_enabled).toBe(false);
    expect(afterMissing?.disabled_reason).toBe('not_participant');
  });

  it('sync_clears_next_sync_after_and_never_touches_send_enabled', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const groupJid = '120363000000000002@g.us';
    const seeded = await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid,
      sendEnabled: true,
      nextSyncAfter: new Date(),
    });

    const { socket } = fakeSocket(
      { [groupJid]: { participants: [{ id: 'self@s.whatsapp.net' }] } },
      'self@s.whatsapp.net',
    );
    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: socket,
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const state = await readWaGroupState(pool, seeded.id);
    expect(state?.next_sync_after).toBeNull();
    expect(state?.send_enabled).toBe(true);
  });
});

describe('pending group leaves', () => {
  it('a_pending_leave_is_executed_once_and_marked_left', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      leaveRequestedAt: new Date(),
    });

    const leaveCalls: string[] = [];
    const groupSocket: GroupSocketPort = {
      groupFetchAllParticipating: async () => ({}),
      groupLeave: async (jid: string) => {
        leaveCalls.push(jid);
      },
      selfJid: () => undefined,
    };

    await runPendingGroupLeaves({
      tenantDb,
      clientId,
      instanceId,
      groupSocket,
      logger: { warn: () => undefined },
    });

    expect(leaveCalls).toEqual([group.groupJid]);
    const state = await readWaGroupState(pool, group.id);
    expect(state?.left_at).not.toBeNull();

    await runPendingGroupLeaves({
      tenantDb,
      clientId,
      instanceId,
      groupSocket,
      logger: { warn: () => undefined },
    });
    expect(leaveCalls).toEqual([group.groupJid]);
  });
});
