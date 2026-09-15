import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './instances-routes-test-support.js';

/**
 * instance-delete.routes.integration.test.ts (2026-09-15 founder request) -
 * `DELETE /v1/instances/:id`. Split from instance-link.routes.integration.test.ts
 * (max-lines discipline, same as every other instance-link sibling file).
 *
 * Covers exactly the three things the founder's brief called load-bearing:
 * (1) a deletable (never-linked) instance is soft-deleted AND disappears from
 * the `GET /v1/queue-status` list every panel surface reads its "numbers"
 * from (`use-instance-list.ts`'s own doc comment - there is no `GET
 * /v1/instances` route); (2) a `linked` instance is REFUSED with 409
 * INVALID_STATE, never silently destroyed; (3) deleting actually frees the
 * `max_registered_instances` plan slot the founder was stuck on - proven by
 * creating a SECOND instance after deleting the first at cap 1, which would
 * 409 REGISTERED_LIMIT_REACHED if instance-count-registered.sql did not
 * already filter `deleted_at IS NULL` (it does - see that file's own header).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const createdPlanIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildInstancesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupInstancesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

async function readyClient(
  label: string,
  limits: { maxRegisteredInstances: number; maxConnectedInstances: number } = {
    maxRegisteredInstances: 5,
    maxConnectedInstances: 5,
  },
): Promise<{ mfaAccessToken: string; clientId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId, limits);
  createdPlanIds.push(planId);
  return { mfaAccessToken, clientId: client.clientId };
}

async function createInstance(mfaAccessToken: string, label: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/instances',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string };
}

async function queueStatusInstanceIds(mfaAccessToken: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/queue-status',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json().data as { instances: { instanceId: string }[] };
  return body.instances.map((row) => row.instanceId);
}

describe('DELETE /v1/instances/:id', () => {
  it('a_never_linked_instance_is_soft_deleted_and_disappears_from_the_list', async () => {
    const { clientId, mfaAccessToken } = await readyClient('delete-happy-path');
    const created = await createInstance(mfaAccessToken, 'dead-weight');

    // Sanity: it starts out in the list (queue-status is THE list source).
    expect(await queueStatusInstanceIds(mfaAccessToken)).toContain(created.id);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${created.id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json().data).toEqual({ deleted: true });

    const row = await pool.query<{ deleted_at: Date | null; desired_state: string }>(
      'SELECT deleted_at, desired_state FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.deleted_at).not.toBeNull();
    expect(row.rows[0]?.desired_state).toBe('offline');

    // Disappears from the list every panel surface reads (P26b's
    // use-instance-list.ts) - queue-status-per-instance.sql's own
    // `deleted_at IS NULL` filter.
    expect(await queueStatusInstanceIds(mfaAccessToken)).not.toContain(created.id);

    const audit = await pool.query<{ action: string; actor_type: string }>(
      `SELECT action, actor_type FROM audit_logs
        WHERE client_id = $1 AND target_id = $2 AND action = 'instance.deleted'`,
      [clientId, created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_type).toBe('user');
  });

  it('a_repeat_delete_call_is_a_harmless_no_op_not_a_double_delete', async () => {
    const { mfaAccessToken } = await readyClient('delete-idempotent');
    const created = await createInstance(mfaAccessToken, 'delete-twice');

    const first = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${created.id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(first.statusCode).toBe(200);

    // Second call: instance-soft-delete.sql's own `deleted_at IS NULL`
    // WHERE-clause guard means this UPDATE now matches zero rows - the route
    // maps that to 404 NOT_FOUND (loadOwnedOrNotFound already returns null
    // for a deleted row - readLinkStatus has no `deleted_at` escape hatch),
    // never a second audit row.
    const second = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${created.id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(second.statusCode).toBe(404);

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'instance.deleted'`,
      [created.id],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('a_linked_instance_is_refused_with_invalid_state_and_is_not_touched', async () => {
    const { mfaAccessToken } = await readyClient('delete-refused-linked');
    const created = await createInstance(mfaAccessToken, 'currently-linked');

    // Drive link_state to 'linked' directly (no HTTP route completes a real
    // pairing handshake outside the engine/provider - same "set the state
    // column directly, out of scope to fake the engine" idiom
    // instance-link.caps.integration.test.ts already uses for
    // PAIRING_EXPIRED).
    await pool.query(
      `UPDATE whatsapp_instances SET link_state = 'linked', health_state = 'connected'
        WHERE id = $1`,
      [created.id],
    );

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${created.id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(deleteResponse.statusCode).toBe(409);
    expect((deleteResponse.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE',
    );

    const row = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.deleted_at).toBeNull();

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'instance.deleted'`,
      [created.id],
    );
    expect(auditRows.rows).toHaveLength(0);
  });

  it('deleting_frees_the_registered_instance_plan_slot', async () => {
    // The whole point of this feature (founder's brief, item 4): at
    // maxRegisteredInstances = 1, a dead instance blocks a replacement
    // forever until it is deleted.
    const { mfaAccessToken } = await readyClient('delete-frees-slot', {
      maxRegisteredInstances: 1,
      maxConnectedInstances: 1,
    });
    const first = await createInstance(mfaAccessToken, 'dead-number');

    const blockedSecond = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: 'replacement-before-delete' },
    });
    expect(blockedSecond.statusCode).toBe(409);
    expect((blockedSecond.json() as { error: { code: string } }).error.code).toBe(
      'REGISTERED_LIMIT_REACHED',
    );

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${first.id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(deleteResponse.statusCode).toBe(200);

    // Now the same cap-1 client can register a replacement - proves
    // instance-count-registered.sql's `deleted_at IS NULL` filter actually
    // excludes the just-deleted row from the count.
    const replacement = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: 'replacement-after-delete' },
    });
    expect(replacement.statusCode).toBe(201);
  });

  it('delete_is_scoped_to_the_owning_client', async () => {
    const owner = await readyClient('delete-owner');
    const other = await readyClient('delete-other');
    const created = await createInstance(owner.mfaAccessToken, 'owner-instance');

    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/instances/${created.id}`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
    });
    expect(foreignDelete.statusCode).toBe(404);
    expect((foreignDelete.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const row = await pool.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.deleted_at).toBeNull();
  });
});
