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
 * groups-routes.integration.test.ts (P24 Unit U3, step 4/5) - real Postgres,
 * real HTTP (a real Fastify app via `buildGroupsRoutesHarness`, real signed
 * JWTs). `seedPacingInstance` seeds one client + whatsapp_instance +
 * instance_pacing_state per tenant (two independent tenants A/B for the
 * isolation proof); `seedWaGroup` seeds `wa_groups` rows.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let app: FastifyInstance;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-routes-test',
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

describe('groups routes - leave is always allowed and audited', () => {
  it('leaving_a_group_is_always_allowed_and_audited', async () => {
    const userId = randomUUID();
    for (const healthBand of ['healthy', 'watch', 'degraded', 'critical']) {
      for (const warmupTier of [1, 6]) {
        const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
          healthBand,
          warmupTier,
        });
        const group = await seedWaGroup(pool, { clientId, instanceId, sendEnabled: true });

        const headers = await authHeader(clientId, userId);
        const first = await app.inject({
          method: 'POST',
          url: `/v1/groups/${group.id}/leave`,
          headers,
        });
        expect(first.statusCode).toBe(202);
        const firstBody = JSON.parse(first.body) as { data: { leaveRequestedAt: string } };

        const auditRows = await pool.query<{ action: string }>(
          `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.leave_requested'`,
          [clientId, group.id],
        );
        expect(auditRows.rows).toHaveLength(1);

        const second = await app.inject({
          method: 'POST',
          url: `/v1/groups/${group.id}/leave`,
          headers: await authHeader(clientId, userId),
        });
        expect(second.statusCode).toBe(202);
        const secondBody = JSON.parse(second.body) as { data: { leaveRequestedAt: string } };
        expect(secondBody.data.leaveRequestedAt).toBe(firstBody.data.leaveRequestedAt);

        const auditRowsAfter = await pool.query<{ action: string }>(
          `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.leave_requested'`,
          [clientId, group.id],
        );
        expect(auditRowsAfter.rows).toHaveLength(1);
      }
    }
  }, 30_000);
});

describe('groups routes - tenant isolation', () => {
  it('another_tenants_group_is_invisible_and_unmodifiable', async () => {
    const a = await seedPacingInstance(pool, probeClientIds, {});
    const b = await seedPacingInstance(pool, probeClientIds, {});

    const group = await seedWaGroup(pool, { clientId: a.clientId, instanceId: a.instanceId });
    const before = await readWaGroupState(pool, group.id);

    const userIdB = randomUUID();
    const headersB = await authHeader(b.clientId, userIdB);

    const listResp = await app.inject({
      method: 'GET',
      url: `/v1/instances/${a.instanceId}/groups`,
      headers: headersB,
    });
    expect(listResp.statusCode).toBe(404);

    const patchResp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${group.id}/send-enabled`,
      headers: headersB,
      payload: { sendEnabled: true },
    });
    expect(patchResp.statusCode).toBe(404);

    const leaveResp = await app.inject({
      method: 'POST',
      url: `/v1/groups/${group.id}/leave`,
      headers: headersB,
    });
    expect(leaveResp.statusCode).toBe(404);

    const after = await readWaGroupState(pool, group.id);
    expect(after).toEqual(before);
  });
});

describe('groups routes - enable/disable device budget + announce role', () => {
  it('enabling_beyond_the_device_budget_is_refused_naming_the_total', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();

    // 1990 devices already enabled across other groups (995 participants x 2).
    await seedWaGroup(pool, {
      clientId,
      instanceId,
      sendEnabled: true,
      participantCount: 995,
      trackedParticipantDevices: 1990,
    });

    const over = await seedWaGroup(pool, {
      clientId,
      instanceId,
      participantCount: 6,
      trackedParticipantDevices: 12,
    });
    const overResp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${over.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(overResp.statusCode).toBe(422);
    const overBody = JSON.parse(overResp.body) as {
      error: {
        code: string;
        details: { reason: string; trackedDevicesEnabledTotal: number; max: number };
      };
    };
    expect(overBody.error.code).toBe('GROUP_NOT_SENDABLE');
    expect(overBody.error.details.reason).toBe('DEVICE_BUDGET_EXCEEDED');
    expect(overBody.error.details.trackedDevicesEnabledTotal).toBe(1990);
    expect(overBody.error.details.max).toBe(2000);
    const overState = await readWaGroupState(pool, over.id);
    expect(overState?.send_enabled).toBe(false);
    const overAudit = await pool.query(`SELECT 1 FROM audit_logs WHERE target_id = $1`, [over.id]);
    expect(overAudit.rows).toHaveLength(0);

    const under = await seedWaGroup(pool, {
      clientId,
      instanceId,
      participantCount: 5,
      trackedParticipantDevices: 10,
    });
    const underResp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${under.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(underResp.statusCode).toBe(200);
    const underState = await readWaGroupState(pool, under.id);
    expect(underState?.send_enabled).toBe(true);
  });

  it('an_announce_group_where_we_are_a_member_cannot_be_enabled', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();

    const memberGroup = await seedWaGroup(pool, {
      clientId,
      instanceId,
      isAnnounce: true,
      ourRole: 'member',
    });
    const memberResp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${memberGroup.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(memberResp.statusCode).toBe(422);
    const memberBody = JSON.parse(memberResp.body) as { error: { details: { reason: string } } };
    expect(memberBody.error.details.reason).toBe('ANNOUNCE_MEMBER_ONLY');

    const adminGroup = await seedWaGroup(pool, {
      clientId,
      instanceId,
      isAnnounce: true,
      ourRole: 'admin',
    });
    const adminResp = await app.inject({
      method: 'PATCH',
      url: `/v1/groups/${adminGroup.id}/send-enabled`,
      headers: await authHeader(clientId, userId),
      payload: { sendEnabled: true },
    });
    expect(adminResp.statusCode).toBe(200);
  });
});
