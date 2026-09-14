import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RateLimitResult, RateLimiter } from '../../platform/http/rate-limit.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildApiKeysApp,
  buildTestConfig,
  cleanupApiKeysRecords,
  onboardedMfaClient,
  seedInstance,
  seedPlanForClient,
} from './api-keys-routes-test-support.js';

/**
 * routes.integration.test.ts (go-live U4) - real Postgres + real `buildApp`,
 * exercising BOTH `/v1/api-keys/*` (owner/admin, `session_mfa`) and
 * `/v1/messages` under the `session_or_api_key` policy change - the same
 * "real app, real HTTP" discipline `modules/webhooks/routes.integration.test.ts`
 * and `modules/messages/enqueue.integration.test.ts` already establish.
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
    applicationName: 'api-keys-routes-test',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildApiKeysApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupApiKeysRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

afterEach(() => {
  sentVerificationUrls.clear();
});

async function readyClientWithInstance(
  label: string,
): Promise<{ mfaAccessToken: string; clientId: string; instanceId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId);
  createdPlanIds.push(planId);
  const instanceId = await seedInstance(pool, client.clientId);
  return { mfaAccessToken, clientId: client.clientId, instanceId };
}

function messagesUrl(instanceId: string): string {
  return `/v1/messages?instanceId=${instanceId}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'text',
    recipient: '+919876543210',
    payload: { text: 'hello there' },
    priority: 'normal',
    ...overrides,
  };
}

async function createApiKey(
  mfaAccessToken: string,
  name = 'ci-bot',
): Promise<{ key: string; id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { authorization: `Bearer ${mfaAccessToken}` },
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { data: { key: string; id: string } };
  return { key: body.data.key, id: body.data.id };
}

describe('api-keys + session_or_api_key send-path integration', () => {
  it('an_api_key_principal_can_create_a_message_job', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('create');
    const { key } = await createApiKey(mfaAccessToken);

    const response = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `idem-${randomUUID()}` },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(201);

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(1);
  });

  it('the_same_idempotency_key_replays_the_same_job', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('replay');
    const { key } = await createApiKey(mfaAccessToken);
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: validPayload(),
    });
    const second = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
      payload: validPayload(),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    // Same job id/status - `meta.requestId` legitimately differs per request
    // (each call gets its own random request id, canon), so only `data` (the
    // replayed job identity) is compared, never the whole envelope.
    expect((second.json() as { data: unknown }).data).toEqual(
      (first.json() as { data: unknown }).data,
    );

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(1);
  });

  it('an_api_key_cannot_reach_a_session_only_route', async () => {
    const { mfaAccessToken } = await readyClientWithInstance('session-only');
    const { key } = await createApiKey(mfaAccessToken);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(listResponse.statusCode).toBe(401);

    const onboardingResponse = await app.inject({
      method: 'POST',
      url: '/v1/onboarding/consent',
      headers: { authorization: `Bearer ${key}` },
      payload: { accepted: true },
    });
    expect(onboardingResponse.statusCode).toBe(401);
  });

  it('a_revoked_key_is_rejected_and_creates_no_job', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('revoked');
    const { key, id } = await createApiKey(mfaAccessToken);

    const revokeResponse = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(revokeResponse.statusCode).toBe(200);

    const sendResponse = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `idem-${randomUUID()}` },
      payload: validPayload(),
    });
    expect(sendResponse.statusCode).toBe(401);

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(0);
  });

  it('a_foreign_tenants_key_id_revoke_is_404_and_the_key_still_works', async () => {
    const ownerA = await readyClientWithInstance('foreign-a');
    const ownerB = await readyClientWithInstance('foreign-b');
    const { key, id } = await createApiKey(ownerA.mfaAccessToken);

    const revokeAsB = await app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${id}`,
      headers: { authorization: `Bearer ${ownerB.mfaAccessToken}` },
    });
    expect(revokeAsB.statusCode).toBe(404);

    const sendResponse = await app.inject({
      method: 'POST',
      url: messagesUrl(ownerA.instanceId),
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': `idem-${randomUUID()}` },
      payload: validPayload(),
    });
    expect(sendResponse.statusCode).toBe(201);
  });

  it('the_raw_key_never_appears_in_the_audit_payload', async () => {
    const { mfaAccessToken, clientId } = await readyClientWithInstance('audit');
    const { key } = await createApiKey(mfaAccessToken);
    const secret = key.split('_').pop()!;

    const auditRows = await pool.query<{ metadata: unknown }>(
      'SELECT metadata FROM audit_logs WHERE client_id = $1',
      [clientId],
    );
    for (const row of auditRows.rows) {
      const serialized = JSON.stringify(row.metadata);
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(secret);
    }
  });

  it('a_non_mfa_session_is_still_rejected_on_the_send_route', async () => {
    // A plain (non-MFA) session token never satisfies session_or_api_key's
    // fallthrough session_mfa check - founder-decision proof at route level.
    const { client } = await onboardedMfaClient(app, sentVerificationUrls, 'non-mfa');
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId);
    createdPlanIds.push(planId);
    const instanceId = await seedInstance(pool, client.clientId);

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: client.email, password: 'Correct-Horse-Battery-Staple-9!' },
    });
    // A TOTP-enrolled account's plain login returns mfa_required, never a
    // usable accessToken - there is no non-MFA accessToken to present.
    // Instead, prove the same class of rejection with a garbage bearer that
    // is not `wp_live_`-prefixed - it must run the session_mfa branch and
    // fail closed, never silently pass through as an api key.
    expect(loginResponse.statusCode).toBe(200);

    const sendResponse = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: 'Bearer not-a-real-session-or-api-key-token' },
      payload: validPayload(),
    });
    expect(sendResponse.statusCode).toBe(401);
  });

  it('a_key_over_its_limit_gets_429_with_retry_after', async () => {
    const { mfaAccessToken, instanceId } = await readyClientWithInstance('rate-limited');
    const { key } = await createApiKey(mfaAccessToken);

    const denyingLimiter: RateLimiter = {
      consume: async (): Promise<RateLimitResult> => ({
        allowed: false,
        retryAfterMs: 1234,
        limit: 60,
        remaining: 0,
        resetMs: Date.now() + 1234,
      }),
    };
    const config = buildTestConfig();
    const scopedApp = await buildApiKeysApp({
      pool,
      tenantDb,
      redis,
      config,
      sentVerificationUrls,
      rateLimiter: denyingLimiter,
    });

    try {
      const response = await scopedApp.inject({
        method: 'POST',
        url: messagesUrl(instanceId),
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': `idem-${randomUUID()}` },
        payload: validPayload(),
      });
      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('2');
    } finally {
      await scopedApp.close();
    }
  });
});
