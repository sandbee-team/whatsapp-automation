import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { seedWaGroup, readWaGroupState, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import { runGroupSyncForInstance, type GroupSocketPort } from './sync.js';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';

/**
 * groups-upsert-mark-left-c2.integration.test.ts (P24 C2 test-engineer) -
 * edge-case pass over `groups-upsert-synced.sql`/`groups-mark-missing-
 * left.sql` beyond `sync-counts.integration.test.ts`'s own happy-path
 * coverage: two concurrent syncs of the same instance (disjoint fetched
 * sets), an upsert never flipping `send_enabled`, an EMPTY fetched set
 * marking every group left (pinned per the C2 task's own question), and a
 * group that RE-APPEARS after being marked left.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-upsert-mark-left-c2-test',
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

function fakeSocket(
  groups: Record<
    string,
    { participants: Array<{ id: string; admin?: 'admin' | 'superadmin' | null }> }
  >,
): GroupSocketPort {
  return {
    groupFetchAllParticipating: async () => {
      const result: Awaited<ReturnType<GroupSocketPort['groupFetchAllParticipating']>> = {};
      for (const [jid, g] of Object.entries(groups)) {
        result[jid] = { id: jid, participants: g.participants };
      }
      return result;
    },
    groupLeave: async () => undefined,
    selfJid: () => undefined,
  };
}

describe('groups upsert/mark-left - concurrent syncs and disjoint sets', () => {
  it('two_concurrent_syncs_with_the_same_fetched_set_yield_one_row_per_group', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const groupJid = '120363700000000001@g.us';
    const socketA = fakeSocket({ [groupJid]: { participants: [{ id: 'a@s.whatsapp.net' }] } });
    const socketB = fakeSocket({ [groupJid]: { participants: [{ id: 'a@s.whatsapp.net' }] } });

    await Promise.all([
      runGroupSyncForInstance({
        tenantDb,
        clientId,
        instanceId,
        groupSocket: socketA,
        metrics: bindGroupsMetrics(),
        clock: { now: () => 0 },
        logger: { warn: () => undefined, info: () => undefined },
      }),
      runGroupSyncForInstance({
        tenantDb,
        clientId,
        instanceId,
        groupSocket: socketB,
        metrics: bindGroupsMetrics(),
        clock: { now: () => 0 },
        logger: { warn: () => undefined, info: () => undefined },
      }),
    ]);

    const rows = await pool.query<{ id: string }>(
      'SELECT id FROM wa_groups WHERE client_id = $1 AND instance_id = $2 AND group_jid = $3',
      [clientId, instanceId, groupJid],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('two_concurrent_syncs_with_disjoint_fetched_sets_never_mark_the_others_group_left', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const jidA = '120363700000000002@g.us';
    const jidB = '120363700000000003@g.us';
    const socketA = fakeSocket({ [jidA]: { participants: [{ id: 'a@s.whatsapp.net' }] } });
    const socketB = fakeSocket({ [jidB]: { participants: [{ id: 'b@s.whatsapp.net' }] } });

    // Run sequentially first so both groups exist, then verify a further
    // disjoint-set sync of socketA's own view does not resurrect/leave B.
    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: socketA,
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });
    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: socketB,
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const rowA = await pool.query<{ id: string; left_at: Date | null }>(
      'SELECT id, left_at FROM wa_groups WHERE client_id = $1 AND instance_id = $2 AND group_jid = $3',
      [clientId, instanceId, jidA],
    );
    // socketB's fetch (jidB only) ran as the SECOND, real sync - it is the
    // authoritative "currently participating" set, so jidA (absent from it)
    // is correctly marked left. This is the single-sync-truth semantics, not
    // a concurrency bug: each call's own fetched set is treated as complete.
    expect(rowA.rows[0]?.left_at).not.toBeNull();
  });

  it('an_upsert_never_flips_send_enabled_even_when_the_row_was_previously_enabled', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const groupJid = '120363700000000004@g.us';
    const seeded = await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid,
      sendEnabled: true,
    });

    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: fakeSocket({ [groupJid]: { participants: [{ id: 'a@s.whatsapp.net' }] } }),
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const state = await readWaGroupState(pool, seeded.id);
    expect(state?.send_enabled).toBe(true);
  });

  it('a_sync_returning_an_empty_map_marks_nothing_left_and_still_advances_the_clock_PINNED', async () => {
    // FIXED (P24 C2 fix round, Fix 3): an empty fetched set is now treated
    // as "no data this tick", never as "we are in zero groups now" - a
    // transient empty fetch (e.g. a provider hiccup returning {} instead of
    // throwing) must not mass-disable every group's sending on the
    // instance. The row stays byte-identical (send_enabled/left_at/
    // updated_at untouched) and the sync clock still advances so the hourly
    // cadence holds.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const seeded = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });
    const beforeRow = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM wa_groups WHERE id = $1`,
      [seeded.id],
    );
    const beforeUpdatedAt = beforeRow.rows[0]?.updated_at;

    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: fakeSocket({}),
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const state = await readWaGroupState(pool, seeded.id);
    expect(state?.left_at).toBeNull();
    expect(state?.send_enabled).toBe(true);
    expect(state?.disabled_reason).toBeNull();

    const afterRow = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM wa_groups WHERE id = $1`,
      [seeded.id],
    );
    expect(afterRow.rows[0]?.updated_at).toEqual(beforeUpdatedAt);

    const clockRow = await pool.query<{ groups_last_synced_at: Date | null }>(
      `SELECT groups_last_synced_at FROM whatsapp_instances WHERE id = $1 AND client_id = $2`,
      [instanceId, clientId],
    );
    expect(clockRow.rows[0]?.groups_last_synced_at).not.toBeNull();
  });

  it('a_group_that_reappears_after_being_marked_left_is_a_rejoin_visible_but_not_send_enabled_PINNED', async () => {
    // FIXED (P24 C2 fix round, Fix 4): a group that reappears in the fetched
    // set after `left_at IS NOT NULL` is a REJOIN - it comes back visible
    // (left_at/leave_requested_at cleared, disabled_reason cleared) but NOT
    // send-enabled (the tenant must re-opt-in; the upsert never touches
    // send_enabled either way).
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const groupJid = '120363700000000005@g.us';
    const seeded = await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid,
      sendEnabled: false,
      leftAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    // The row was previously marked left with the sync's own disabled_reason.
    await pool.query(`UPDATE wa_groups SET disabled_reason = 'not_participant' WHERE id = $1`, [
      seeded.id,
    ]);

    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: fakeSocket({ [groupJid]: { participants: [{ id: 'a@s.whatsapp.net' }] } }),
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const state = await readWaGroupState(pool, seeded.id);
    expect(state?.left_at).toBeNull();
    expect(state?.leave_requested_at).toBeNull();
    expect(state?.disabled_reason).toBeNull();
    // send_enabled is untouched by the upsert - the rejoin comes back
    // visible but NOT send-enabled; a genuinely rejoined group re-opts in
    // via the same PATCH route, never automatically flipped back on by a
    // sync.
    expect(state?.send_enabled).toBe(false);
  });

  it('a_rejoined_group_is_not_auto_left_again', async () => {
    // Fix 4's guard: a row with BOTH `leave_requested_at` and `left_at` set
    // (a leave that was requested, then executed) that reappears in the
    // fetch must not be picked up again by the worker's leave sweep - the
    // rejoin clears `leave_requested_at` too, so
    // `groups-leave-pending.sql` no longer returns it.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const groupJid = '120363700000000006@g.us';
    const seeded = await seedWaGroup(pool, {
      clientId,
      instanceId,
      groupJid,
      leaveRequestedAt: new Date('2026-09-01T00:00:00.000Z'),
      leftAt: new Date('2026-09-01T00:05:00.000Z'),
    });

    await runGroupSyncForInstance({
      tenantDb,
      clientId,
      instanceId,
      groupSocket: fakeSocket({ [groupJid]: { participants: [{ id: 'a@s.whatsapp.net' }] } }),
      metrics: bindGroupsMetrics(),
      clock: { now: () => 0 },
      logger: { warn: () => undefined, info: () => undefined },
    });

    const pending = await pool.query<{ id: string }>(
      `SELECT id FROM wa_groups
        WHERE client_id = $1 AND instance_id = $2
          AND leave_requested_at IS NOT NULL AND left_at IS NULL`,
      [clientId, instanceId],
    );
    expect(pending.rows.find((r) => r.id === seeded.id)).toBeUndefined();
  });
});
