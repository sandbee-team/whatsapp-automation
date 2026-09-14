import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { seedWaGroup, readWaGroupState, cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  buildGroupsRoutesHarness,
  signAccessToken,
} from './__tests__/groups-route-test-support.js';

/**
 * groups-enable-race-c2.integration.test.ts (P24 C2 test-engineer) - the
 * enable/disable device-budget edge cases beyond `groups-routes.integration.
 * test.ts`'s own happy-path coverage: two CONCURRENT enable requests that
 * each fit alone but not together (a real race, not a read-then-write
 * simulation), replay of the same PATCH via the idempotent-no-op branch,
 * enabling a group with `participant_count` NULL, a group with zero tracked
 * devices, and the exact 2000-vs-2001 boundary.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let app: FastifyInstance;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-enable-race-c2-test',
  });
  tenantDb = createTenantDb(pool);
  app = buildGroupsRoutesHarness(tenantDb);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupWaGroups(pool, probeClientIds);
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function authHeader(clientId: string, userId: string): Promise<Record<string, string>> {
  const token = await signAccessToken({ userId, clientId, role: 'owner' });
  return { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() };
}

describe('groups enable - concurrent race at the device budget boundary', () => {
  it('two_concurrent_enables_that_each_fit_alone_but_not_together_at_most_one_succeeds', async () => {
    // 1990 already enabled + two candidates of 10 each: 1990+10=2000 (fits),
    // 1990+10+10=2010 (does not). A real race: both PATCHes fired
    // concurrently against the SAME instance - the row lock inside
    // `getGroupForUpdate` (FOR UPDATE) must serialize them so the SECOND
    // one to actually execute sees the FIRST one's already-enabled total.
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 995,
      trackedParticipantDevices: 1990,
    });
    const groupX = await seedWaGroup(pool, {
      clientId,
      instanceId,
      participantCount: 5,
      trackedParticipantDevices: 10,
    });
    const groupY = await seedWaGroup(pool, {
      clientId,
      instanceId,
      participantCount: 5,
      trackedParticipantDevices: 10,
    });

    const [respX, respY] = await Promise.all([
      app.inject({
        method: 'PATCH',
        url: `/v1/groups/${groupX.id}/send-enabled`,
        headers: await authHeader(clientId, userId),
        payload: { sendEnabled: true },
      }),
      app.inject({
        method: 'PATCH',
        url: `/v1/groups/${groupY.id}/send-enabled`,
        headers: await authHeader(clientId, userId),
        payload: { sendEnabled: true },
      }),
    ]);

    const codes = [respX.statusCode, respY.statusCode].sort();
    // At most one 200 - the other is either 200 (if it ran first and the
    // total stayed within budget) or 422; never both 200 (that would mean
    // 2010 devices, over budget, both silently accepted - a real
    // read-then-write race).
    const successCount = codes.filter((c) => c === 200).length;
    expect(successCount).toBeLessThanOrEqual(1);
    expect(codes.filter((c) => c === 422).length).toBeGreaterThanOrEqual(1);

    const stateX = await readWaGroupState(pool, groupX.id);
    const stateY = await readWaGroupState(pool, groupY.id);
    const enabledCount = [stateX?.send_enabled, stateY?.send_enabled].filter(Boolean).length;
    expect(enabledCount).toBeLessThanOrEqual(1);
  });

  it('replaying_the_same_enable_patch_with_the_same_idempotency_key_is_a_noop_with_no_second_audit_row', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    const group = await seedWaGroup(pool, { clientId, instanceId });
    const idempotencyKey = randomUUID();
    const headers = {
      authorization: (await authHeader(clientId, userId)).authorization!,
      'idempotency-key': idempotencyKey,
    };

    const first = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${group.id}/send-enabled`,
      headers,
      payload: { sendEnabled: true },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${group.id}/send-enabled`,
      headers,
      payload: { sendEnabled: true },
    });
    expect(second.statusCode).toBe(200);

    const auditRows = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.send_enabled'`,
      [clientId, group.id],
    );
    // The route has no idempotency-key replay-store (P24 does not build one -
    // see plan file's "Notes and deferred items"); the SERVICE's own
    // current-value no-op check is what prevents a second audit row here,
    // not the idempotency key itself.
    expect(auditRows.rows).toHaveLength(1);
  });

  it('enabling_a_group_with_a_null_participant_count_and_zero_tracked_devices_succeeds', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    const group = await seedWaGroup(pool, {
      clientId,
      instanceId,
      trackedParticipantDevices: 0,
    });
    // `seedWaGroup`'s own `options.participantCount ?? 10` fallback cannot
    // represent an explicit NULL (JS `??` treats `null` as nullish too) - go
    // straight to a raw UPDATE for this one column instead.
    await pool.query('UPDATE wa_groups SET participant_count = NULL WHERE id = $1', [group.id]);

    const resp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${group.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(resp.statusCode).toBe(200);
    const state = await readWaGroupState(pool, group.id);
    expect(state?.send_enabled).toBe(true);
    expect(state?.participant_count).toBeNull();
  });

  it('the_exact_2000_boundary_is_allowed_and_2001_is_refused', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();
    await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      trackedParticipantDevices: 1990,
    });

    const exactly10 = await seedWaGroup(pool, {
      clientId,
      instanceId,
      trackedParticipantDevices: 10,
    });
    const exactlyAt2000 = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${exactly10.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(exactlyAt2000.statusCode).toBe(200);

    const eleven = await seedWaGroup(pool, { clientId, instanceId, trackedParticipantDevices: 11 });
    const resp2011 = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${eleven.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(resp2011.statusCode).toBe(422);

    const oneMore = await seedWaGroup(pool, { clientId, instanceId, trackedParticipantDevices: 1 });
    const resp2001 = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${oneMore.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(resp2001.statusCode).toBe(422);
  });
});
