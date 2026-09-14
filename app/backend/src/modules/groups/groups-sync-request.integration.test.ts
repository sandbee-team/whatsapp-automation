import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  seedPacingInstance,
  cleanupPacingProbeClients,
  type TestPool,
} from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { cleanupWaGroups } from './__tests__/groups-test-helpers.js';
import {
  buildGroupsRoutesHarness,
  signAccessToken,
} from './__tests__/groups-route-test-support.js';

/**
 * groups-sync-request.integration.test.ts (P24 Unit U3c) - real Postgres,
 * real HTTP: `POST /v1/instances/:id/groups/sync`. Migration 0068 grants
 * `wp_app` a column-scoped UPDATE on `groups_sync_requested_at` only - the
 * other two sync-clock columns stay worker-owned, asserted directly here.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let app: FastifyInstance;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'groups-sync-request-test',
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

describe('groups sync request - happy path', () => {
  it('a_sync_request_sets_requested_at_and_is_audited', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/groups/sync`,
      headers: await authHeader(clientId, userId),
    });

    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as {
      data: { requestedAt: string; nextSyncAfter: string | null };
    };
    expect(body.data.requestedAt).not.toBeNull();
    expect(body.data.nextSyncAfter).toBeNull();

    const row = await pool.query<{ groups_sync_requested_at: Date | null }>(
      `SELECT groups_sync_requested_at FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(row.rows[0]?.groups_sync_requested_at).not.toBeNull();

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.sync_requested'`,
      [clientId, instanceId],
    );
    expect(auditRows.rows).toHaveLength(1);
  });
});

describe('groups sync request - rate limit', () => {
  it('a_second_request_inside_the_hour_is_refused_with_retry_after', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const userId = randomUUID();

    await pool.query(
      `UPDATE whatsapp_instances SET groups_next_sync_after = now() + interval '30 minutes' WHERE id = $1`,
      [instanceId],
    );
    const before = await pool.query<{ groups_sync_requested_at: Date | null }>(
      `SELECT groups_sync_requested_at FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/groups/sync`,
      headers: await authHeader(clientId, userId),
    });

    expect(response.statusCode).toBe(429);
    const retryAfter = Number(response.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1790);
    expect(retryAfter).toBeLessThanOrEqual(1800);
    expect(JSON.parse(response.body).error.code).toBe('RATE_LIMITED');

    const after = await pool.query<{ groups_sync_requested_at: Date | null }>(
      `SELECT groups_sync_requested_at FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    expect(after.rows[0]?.groups_sync_requested_at).toEqual(
      before.rows[0]?.groups_sync_requested_at,
    );

    const auditRows = await pool.query(
      `SELECT 1 FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'group.sync_requested'`,
      [clientId, instanceId],
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});

describe('groups sync request - tenant isolation', () => {
  it('another_tenants_instance_is_404', async () => {
    const a = await seedPacingInstance(pool, probeClientIds, {});
    const b = await seedPacingInstance(pool, probeClientIds, {});
    const userIdB = randomUUID();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${a.instanceId}/groups/sync`,
      headers: await authHeader(b.clientId, userIdB),
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('groups sync request - the API cannot move the worker-owned sync clock', () => {
  it('the_api_role_cannot_move_the_sync_clock', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const wpAppDb = createTenantDbAsRole(pool, 'wp_app');

    await expect(
      wpAppDb.withTenant(clientId, (tx) =>
        tx.query(`UPDATE whatsapp_instances SET groups_next_sync_after = now() WHERE id = $1`, [
          instanceId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
