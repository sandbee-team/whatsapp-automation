import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../../platform/redis.js';
import { discoveryWakeChannel } from '../../../engine/fleet/discovery-wake.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './instances-routes-test-support.js';

/**
 * link-discovery-wake.integration.test.ts (2026-09-17, "QR takes 3-12s to
 * appear" fix) - real PG/Redis. Proves `POST /v1/instances/:id/link`
 * publishes the fleet-wide discovery wake (`engine/fleet/discovery-wake.ts`)
 * AFTER its pairing-intent transaction commits - same idiom
 * `resume.integration.test.ts`'s own `resume_publishes_a_wake_and_writes_
 * actor_user_id` established for the per-instance wake: a real Redis
 * subscriber on the real channel, raced against the real HTTP call, no
 * wall-clock sleep/margin.
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

async function createInstance(mfaAccessToken: string, label = 'probe'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/instances',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { label },
  });
  expect(response.statusCode).toBe(201);
  return (response.json().data as { id: string }).id;
}

describe('POST /v1/instances/:id/link discovery wake', () => {
  it('link_publishes_exactly_one_fleet_wide_discovery_wake_after_commit', async () => {
    const { mfaAccessToken } = await readyClient('link-discovery-wake');
    const instanceId = await createInstance(mfaAccessToken, 'link-discovery-wake-instance');

    const channel = discoveryWakeChannel(buildTestConfig().NODE_ENV);
    const subscriber = redis.duplicate();
    await subscriber.subscribe(channel);
    // Deterministic wait: resolves the moment the SAME code path that
    // commits the pairing-intent transaction (link.routes.ts's own doc:
    // the wake publish runs strictly after commit) delivers a real Redis
    // pub/sub message on this exact channel - no wall-clock sleep/margin
    // (same discipline as resume.integration.test.ts's own wake test).
    const receivedChannel = new Promise<string>((resolve) => {
      subscriber.on('message', (ch) => resolve(ch));
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/link`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(response.statusCode).toBe(202);

    await expect(receivedChannel).resolves.toBe(channel);
    await subscriber.unsubscribe(channel);
    await subscriber.quit();

    const row = await pool.query<{ link_state: string; qr_attempts: number }>(
      `SELECT link_state, qr_attempts FROM whatsapp_instances WHERE id = $1`,
      [instanceId],
    );
    // Proves the wake fired for the SAME pairing intent this request made -
    // the row is already 'pairing' with a reset attempt count by the time
    // the wake's own message arrives (commit-then-publish ordering).
    expect(row.rows[0]).toMatchObject({ link_state: 'pairing', qr_attempts: 0 });
  });

  it('a_failed_link_request_never_publishes_a_wake', async () => {
    const { mfaAccessToken } = await readyClient('link-discovery-wake-notfound');
    const channel = discoveryWakeChannel(buildTestConfig().NODE_ENV);
    const subscriber = redis.duplicate();
    await subscriber.subscribe(channel);

    let messageReceived = false;
    subscriber.on('message', () => {
      messageReceived = true;
    });

    const bogusId = '00000000-0000-0000-0000-000000000000';
    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${bogusId}/link`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(response.statusCode).toBe(404);

    // No commit ever happened for this request (loadOwnedOrNotFound throws
    // before beginPairing runs) - give any wrongly-fired wake a moment to
    // arrive, then assert it never did.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messageReceived).toBe(false);

    await subscriber.unsubscribe(channel);
    await subscriber.quit();
  });
});
