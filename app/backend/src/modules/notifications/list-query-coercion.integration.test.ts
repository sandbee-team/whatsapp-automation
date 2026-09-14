import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildListCoercionApp,
  buildTestConfig,
  cleanupListCoercionRecords,
  onboardedClient,
  seedCampaigns,
  seedContacts,
  seedGroups,
  seedInstance,
  seedNotifications,
  seedTopupRequests,
} from './__tests__/list-query-coercion-app-support.js';

/**
 * list-query-coercion.integration.test.ts (P28 U5, item 4) - end-to-end
 * proof that every list route parses `req.query` THROUGH its contract's
 * `z.coerce.number()` `limit` schema: `?limit=5` succeeds and caps the page,
 * `?limit=abc` is a 400 VALIDATION_ERROR, and notifications' own
 * `?unread=true|false` string-enum boolean filters correctly.
 */

const SEED_COUNT = 6;

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildListCoercionApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupListCoercionRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

describe('list routes accept numeric query strings (P28 U5, item 4)', () => {
  it('list_routes_accept_numeric_query_strings', async () => {
    const { client, accessToken } = await onboardedClient(
      app,
      sentVerificationUrls,
      'list-coercion',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const instanceId = await seedInstance(pool, client.clientId);

    await seedNotifications(pool, client.clientId, instanceId, SEED_COUNT);
    await seedTopupRequests(pool, client.clientId, client.userId, SEED_COUNT);
    await seedCampaigns(pool, client.clientId, instanceId, SEED_COUNT);
    await seedGroups(pool, client.clientId, instanceId, SEED_COUNT);
    await seedContacts(pool, client.clientId, SEED_COUNT);

    const authHeader = { authorization: `Bearer ${accessToken}` };

    // --- notifications ---
    const notifOk = await app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=5',
      headers: authHeader,
    });
    expect(notifOk.statusCode).toBe(200);
    expect((notifOk.json().data as { items: unknown[] }).items.length).toBeLessThanOrEqual(5);

    const notifBad = await app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=abc',
      headers: authHeader,
    });
    expect(notifBad.statusCode).toBe(400);

    const notifUnreadFalse = await app.inject({
      method: 'GET',
      url: '/v1/notifications?unread=false',
      headers: authHeader,
    });
    expect(notifUnreadFalse.statusCode).toBe(200);
    const unreadFalseItems = (notifUnreadFalse.json().data as { items: { readAt: unknown }[] })
      .items;
    // ?unread=false includes read items too (never filtered to unread-only).
    expect(unreadFalseItems.some((item) => item.readAt !== null)).toBe(true);

    const notifUnreadTrue = await app.inject({
      method: 'GET',
      url: '/v1/notifications?unread=true',
      headers: authHeader,
    });
    expect(notifUnreadTrue.statusCode).toBe(200);
    const unreadTrueItems = (notifUnreadTrue.json().data as { items: { readAt: unknown }[] }).items;
    expect(unreadTrueItems.length).toBeGreaterThan(0);
    expect(unreadTrueItems.every((item) => item.readAt === null)).toBe(true);

    // --- topup requests ---
    const topupOk = await app.inject({
      method: 'GET',
      url: '/v1/wallet/topup-requests?limit=5',
      headers: authHeader,
    });
    expect(topupOk.statusCode).toBe(200);
    expect((topupOk.json().data as unknown[]).length).toBeLessThanOrEqual(5);

    const topupBad = await app.inject({
      method: 'GET',
      url: '/v1/wallet/topup-requests?limit=abc',
      headers: authHeader,
    });
    expect(topupBad.statusCode).toBe(400);

    // --- broadcasts ---
    const broadcastsOk = await app.inject({
      method: 'GET',
      url: '/v1/broadcasts?limit=5',
      headers: authHeader,
    });
    expect(broadcastsOk.statusCode).toBe(200);
    expect((broadcastsOk.json().data as { items: unknown[] }).items.length).toBeLessThanOrEqual(5);

    const broadcastsBad = await app.inject({
      method: 'GET',
      url: '/v1/broadcasts?limit=abc',
      headers: authHeader,
    });
    expect(broadcastsBad.statusCode).toBe(400);

    // --- groups ---
    const groupsOk = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/groups?limit=5`,
      headers: authHeader,
    });
    expect(groupsOk.statusCode).toBe(200);
    expect((groupsOk.json().data as { items: unknown[] }).items.length).toBeLessThanOrEqual(5);

    const groupsBad = await app.inject({
      method: 'GET',
      url: `/v1/instances/${instanceId}/groups?limit=abc`,
      headers: authHeader,
    });
    expect(groupsBad.statusCode).toBe(400);

    // --- contacts ---
    const contactsOk = await app.inject({
      method: 'GET',
      url: '/v1/contacts?limit=5',
      headers: authHeader,
    });
    expect(contactsOk.statusCode).toBe(200);
    expect((contactsOk.json().data as { items: unknown[] }).items.length).toBeLessThanOrEqual(5);

    const contactsBad = await app.inject({
      method: 'GET',
      url: '/v1/contacts?limit=abc',
      headers: authHeader,
    });
    expect(contactsBad.statusCode).toBe(400);
  });
});
