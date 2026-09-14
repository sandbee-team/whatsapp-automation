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
 * instance-link.edge.integration.test.ts - E3 edge-case pass (P08
 * session-qr-linking). Route-level edge cases not already covered by
 * instance-link.routes.integration.test.ts / instance-link.caps.integration
 * .test.ts: link on a soft-deleted instance (404), online/park idempotency
 * on an already-online/already-parked instance (pinned as 200, since
 * `instance-set-desired-state.sql` has no `WHERE desired_state != ...`
 * guard - re-asserting the SAME desired_state is a legal, idempotent no-op
 * write), a 65-char label failing validation (max is 64,
 * packages/contracts/src/instances.ts), and the concurrent-online-race
 * finding (two requests racing one free connected-instance slot).
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

async function readyClient(label: string): Promise<{ mfaAccessToken: string; clientId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId, {
    maxRegisteredInstances: 5,
    maxConnectedInstances: 5,
  });
  createdPlanIds.push(planId);
  return { mfaAccessToken, clientId: client.clientId };
}

async function createInstance(mfaAccessToken: string, label = 'probe'): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/instances',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { id: string };
}

describe('instance link/park route edge cases', () => {
  it('link_on_a_soft_deleted_instance_returns_404', async () => {
    const { mfaAccessToken, clientId } = await readyClient('soft-deleted-link');
    const created = await createInstance(mfaAccessToken, 'to-delete');

    await pool.query(
      `UPDATE whatsapp_instances SET deleted_at = now(), desired_state = 'offline'
        WHERE id = $1 AND client_id = $2`,
      [created.id, clientId],
    );

    const linkResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(linkResponse.statusCode).toBe(404);
    expect((linkResponse.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('online_on_an_already_online_instance_is_idempotent_200', async () => {
    const { mfaAccessToken } = await readyClient('idempotent-online');
    const created = await createInstance(mfaAccessToken, 'already-online');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    // PINNED: instance-set-desired-state.sql has no "WHERE desired_state !=
    // $desired_state" guard - re-asserting 'online' while already 'online'
    // is a legal idempotent write (still returns a row), not a 409/conflict.
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual({ desiredState: 'online' });

    const row = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.desired_state).toBe('online');
  });

  it('park_on_an_already_parked_instance_is_idempotent_200', async () => {
    const { mfaAccessToken } = await readyClient('idempotent-park');
    const created = await createInstance(mfaAccessToken, 'never-onlined');

    // Freshly created instances already start desired_state='offline' (see
    // instance-create.sql's own default) - park it once more explicitly.
    const first = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/park`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/park`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toMatchObject({ desiredState: 'offline' });

    const row = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.desired_state).toBe('offline');
  });

  it('create_with_a_65_char_label_is_a_400_validation_error', async () => {
    const { mfaAccessToken } = await readyClient('label-too-long');
    const label65 = 'x'.repeat(65);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: label65 },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');

    // Nothing was created for this label.
    const row = await pool.query('SELECT 1 FROM whatsapp_instances WHERE label = $1', [label65]);
    expect(row.rows).toHaveLength(0);
  });

  it('a_64_char_label_is_accepted_at_the_boundary', async () => {
    const { mfaAccessToken } = await readyClient('label-at-boundary');
    const label64 = 'y'.repeat(64);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: label64 },
    });

    expect(response.statusCode).toBe(201);
    expect((response.json().data as { label: string }).label).toBe(label64);
  });

  it('FINDING: two concurrent online requests racing one free slot - pins the observed outcome', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'concurrent-online-race',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 1,
    });
    createdPlanIds.push(planId);

    const instanceA = await createInstance(mfaAccessToken, 'race-a');
    const instanceB = await createInstance(mfaAccessToken, 'race-b');

    // Fire both online requests concurrently (no await between them) - each
    // request's own "count online, then set desired_state" is two separate
    // statements with NO conditional-update guard tying the count-check to
    // the write (repo.ts's setDesiredState has no WHERE clause capping the
    // total online count) - see instances.routes.ts's online handler.
    const [responseA, responseB] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceA.id}/online`,
        headers: { authorization: `Bearer ${mfaAccessToken}` },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/instances/${instanceB.id}/online`,
        headers: { authorization: `Bearer ${mfaAccessToken}` },
      }),
    ]);

    const onlineRow = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM whatsapp_instances
        WHERE client_id = $1 AND desired_state = 'online' AND deleted_at IS NULL`,
      [client.clientId],
    );
    const onlineCount = Number(onlineRow.rows[0]?.count ?? '0');

    // FIXED (P08 E3 FIX 3): the check-and-set is now atomic (one transaction,
    // per-client `SELECT ... FOR UPDATE` serialising the racing requests) -
    // exactly ONE of the two racers lands online, the other gets 409
    // NO_FREE_SLOT, and the final online count equals the cap (1).
    expect(onlineCount).toBe(1);
    expect([responseA.statusCode, responseB.statusCode].sort()).toEqual([200, 409]);

    const loser = responseA.statusCode === 409 ? responseA : responseB;
    expect((loser.json() as { error: { code: string } }).error.code).toBe('NO_FREE_SLOT');
  });
});
