import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, tenantKey } from '../../../platform/redis.js';
import { writeQrCache } from '../../../engine/session/qr-cache.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './instances-routes-test-support.js';

/**
 * instance-link.qr-fallback.integration.test.ts (2026-09-22, "first QR
 * lost" fix, Task 1) - the REST QR fallback regression tests, split from
 * instance-link.routes.integration.test.ts for max-lines (same precedent as
 * that file's own caps/masking siblings).
 *
 * `link_status_serves_a_qr_published_before_any_client_ever_polled_or_
 * subscribed` is the test this fix exists for. TWO earlier fixes (wiring
 * the Redis bridge subscriber into `roles/api.ts`, then a replay-on-
 * subscribe ring buffer in the SSE hub) both tightened the SSE PUSH path
 * only and neither closed the actual gap, confirmed live twice: the Connect
 * sheet opened showing an empty QR circle because the first QR could be
 * published before any browser finished subscribing. This test calls
 * `writeQrCache` DIRECTLY (exactly what `roles/session-worker.ts`'s
 * `publish` wrapper does on a real `instance.qr` event) with NO SSE
 * connection, NO subscriber, and NO poll loop involved anywhere in the
 * test - then asserts a single, later `GET /link-status` still returns it.
 * This must FAIL without the fix (`qr`/`qrExpiresAt` did not exist on the
 * route's response at all before this change) and PASS with it, proving the
 * REST path genuinely does not depend on push timing.
 *
 * The other two tests prove "never serve an expired QR" from both sides:
 * the write guard (`qr-cache.ts`'s own TTL check) and the read guard
 * (`readQrCache`'s own `expiresAt` re-check, defence in depth against a key
 * still physically present in Redis past its logical expiry).
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
/** Sourced from the SAME config the app was built with, never a hardcoded literal - `qr-cache.ts`'s key namespace must match `roles/api.ts`'s real `qrCache: { redis, env: config.NODE_ENV }` wiring exactly, or a test-written key would silently miss the route's read. */
let env: string;
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
  env = config.NODE_ENV;
  app = await buildInstancesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupInstancesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

async function readyClient(label: string): Promise<{ clientId: string; mfaAccessToken: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId, {
    maxRegisteredInstances: 5,
    maxConnectedInstances: 5,
  });
  createdPlanIds.push(planId);
  return { clientId: client.clientId, mfaAccessToken };
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

interface LinkStatusBody {
  qr: string | null;
  qrExpiresAt: string | null;
}

describe('link-status REST QR fallback', () => {
  it('link_status_serves_a_qr_published_before_any_client_ever_polled_or_subscribed', async () => {
    const { clientId, mfaAccessToken } = await readyClient('qr-fallback');
    const created = await createInstance(mfaAccessToken, 'qr-fallback-instance');

    // Exactly what roles/session-worker.ts's `publish` wrapper does on a
    // real `instance.qr` event - NO SSE connection, NO subscriber, NO poll
    // loop anywhere in this test. This is the frame the browser would have
    // missed under the old push-only design.
    await writeQrCache(redis, {
      env,
      clientId,
      instanceId: created.id,
      qr: {
        payload: 'bearer-qr-payload-published-before-any-listener',
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        attemptsLeft: 4,
      },
    });

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/instances/${created.id}/link-status`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });

    expect(statusResponse.statusCode).toBe(200);
    const body = statusResponse.json().data as LinkStatusBody;
    expect(body.qr).toBe('bearer-qr-payload-published-before-any-listener');
    expect(body.qrExpiresAt).not.toBeNull();

    await redis.del(tenantKey(env, clientId, 'qr', created.id));
  });

  it('writeQrCache_refuses_to_persist_an_already_expired_qr', async () => {
    const { clientId } = await readyClient('qr-expired-write');
    const instanceId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

    // Never even reaches Redis: `writeQrCache`'s own TTL guard (qr-cache.ts)
    // refuses a non-positive PX duration rather than writing a key that
    // would either be rejected by Redis or expire before anyone could ever
    // read it back.
    await writeQrCache(redis, {
      env,
      clientId,
      instanceId,
      qr: {
        payload: 'should-never-be-written',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        attemptsLeft: 4,
      },
    });

    const key = tenantKey(env, clientId, 'qr', instanceId);
    expect(await redis.get(key)).toBeNull();
  });

  it('link_status_never_serves_a_qr_past_its_own_expiresAt_even_if_still_cached', async () => {
    const { clientId, mfaAccessToken } = await readyClient('qr-expired-read');
    const created = await createInstance(mfaAccessToken, 'qr-expired-read-instance');

    // Plants the cache entry DIRECTLY via a raw Redis SET (bypassing
    // `writeQrCache`'s own TTL guard entirely) so this test exercises
    // `readQrCache`'s OWN defence-in-depth re-check of `expiresAt` against
    // `now()` - never serve an expired QR EVEN IF it is still sitting in
    // Redis (e.g. clock skew between this process and Redis, or a key whose
    // TTL simply has not been swept yet). The client-side `QrPanel.isExpired`
    // path is a SEPARATE, already-existing guard - this proves the
    // server-side one independently.
    const key = tenantKey(env, clientId, 'qr', created.id);
    await redis.set(
      key,
      JSON.stringify({
        payload: 'should-never-be-served',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        attemptsLeft: 4,
      }),
      'PX',
      5_000,
    );

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/instances/${created.id}/link-status`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });

    expect(statusResponse.statusCode).toBe(200);
    const body = statusResponse.json().data as LinkStatusBody;
    expect(body.qr).toBeNull();
    expect(body.qrExpiresAt).toBeNull();

    await redis.del(key);
  });
});
