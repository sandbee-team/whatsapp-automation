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
 * instance-link.routes.integration.test.ts (P08 Unit U6c) - the core
 * ownership-scoping + happy-path tests for the six instance link/park
 * routes. Cap/limit and phone-masking tests live in their own sibling files
 * (max-lines discipline) - see instance-link.caps.integration.test.ts and
 * instance-link.masking.integration.test.ts. The REST QR fallback
 * regression tests (2026-09-22, "first QR lost" fix) are their own sibling
 * too - see instance-link.qr-fallback.integration.test.ts - for the SAME
 * reason.
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

describe('instance link/park routes', () => {
  it('create_then_link_then_status_happy_path', async () => {
    const { mfaAccessToken } = await readyClient('happy-path');

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: 'my-first-instance' },
    });
    expect(createResponse.statusCode).toBe(201);
    const createBody = createResponse.json().data as {
      id: string;
      label: string;
      linkState: string;
      healthState: string;
      desiredState: string;
    };
    expect(createBody).toMatchObject({
      label: 'my-first-instance',
      linkState: 'unlinked',
      healthState: 'never_linked',
      desiredState: 'offline',
    });

    const linkResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${createBody.id}/link`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(linkResponse.statusCode).toBe(202);
    expect(linkResponse.json().data).toEqual({ linkState: 'pairing' });

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/instances/${createBody.id}/link-status`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.json().data).toEqual({
      linkState: 'pairing',
      healthState: 'never_linked',
      desiredState: 'online',
      needsUserAction: false,
      userActionReason: null,
      attemptsLeft: 5,
      maskedNumber: null,
      // REST QR fallback (Task 1, "first QR lost" fix, 2026-09-22): no
      // worker ever ran `handleAttempt` in this test, so `qr-cache.ts` has
      // nothing cached for this instance yet - `null` is the correct "no QR
      // issued" state, same as every field above it before a real Baileys
      // socket exists. The cache-hit case is its own test below.
      qr: null,
      qrExpiresAt: null,
    });
  });

  it('registered_cap_blocks_creation', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'registered-cap',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 1,
      maxConnectedInstances: 1,
    });
    createdPlanIds.push(planId);

    const first = await createInstance(mfaAccessToken, 'first');
    expect(first.id).toBeTruthy();

    const countBefore = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM whatsapp_instances WHERE client_id = $1',
      [client.clientId],
    );

    const blocked = await app.inject({
      method: 'POST',
      url: '/v1/instances',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { label: 'second' },
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      'REGISTERED_LIMIT_REACHED',
    );

    const countAfter = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM whatsapp_instances WHERE client_id = $1',
      [client.clientId],
    );
    expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count);
  });

  it('link_and_link_status_are_scoped_to_the_owning_client', async () => {
    const owner = await readyClient('owner');
    const other = await readyClient('other');

    const created = await createInstance(owner.mfaAccessToken, 'owner-instance');

    const foreignLink = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(foreignLink.statusCode).toBe(404);
    expect((foreignLink.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const foreignRefresh = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link/refresh`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
    });
    expect(foreignRefresh.statusCode).toBe(404);
    expect((foreignRefresh.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const foreignStatus = await app.inject({
      method: 'GET',
      url: `/v1/instances/${created.id}/link-status`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
    });
    expect(foreignStatus.statusCode).toBe(404);
    expect((foreignStatus.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const foreignOnline = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/online`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
    });
    expect(foreignOnline.statusCode).toBe(404);
    expect((foreignOnline.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const foreignPark = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/park`,
      headers: { authorization: `Bearer ${other.mfaAccessToken}` },
    });
    expect(foreignPark.statusCode).toBe(404);
    expect((foreignPark.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('park_writes_intent_and_audit_only', async () => {
    const { clientId, mfaAccessToken } = await readyClient('park-intent');
    const created = await createInstance(mfaAccessToken, 'to-park');

    const onlineResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(onlineResponse.statusCode).toBe(200);

    const parkResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/park`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(parkResponse.statusCode).toBe(200);
    const parkBody = parkResponse.json().data as { desiredState: string; parkedCopy: string };
    expect(parkBody.desiredState).toBe('offline');
    expect(parkBody.parkedCopy).toMatch(/^Parked/u);

    const row = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.desired_state).toBe('offline');

    const audit = await pool.query<{ action: string; actor_type: string; actor_user_id: string }>(
      `SELECT action, actor_type, actor_user_id FROM audit_logs
        WHERE client_id = $1 AND target_id = $2 AND action = 'instance.parked'`,
      [clientId, created.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_type).toBe('user');
  });
});
