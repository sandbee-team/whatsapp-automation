import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './__tests__/instances-routes-test-support.js';

/**
 * resume-validation.integration.test.ts (P16 fix round, WARNING 6 + 7 -
 * max-lines split of resume.integration.test.ts, same sibling-module split
 * idiom as session-worker-discovery-wiring.ts - not a behavioural boundary)
 * - real PG/Redis. Proves: a non-UUID :id param is mapped to a 400
 * VALIDATION_ERROR, never an unmapped Postgres uuid-cast 500; a free-text
 * resume reason carrying a phone-shaped digit run is redacted before it
 * enters audit_logs.metadata.
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

afterEach(async () => {
  await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [createdClientIds]);
});

async function pauseForRestriction(instanceId: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_instances SET health_state = 'paused', pause_reason = 'provider_restriction',
        needs_user_action = true, user_action_reason = 'RESTRICTION_SIGNAL'
      WHERE id = $1`,
    [instanceId],
  );
}

async function readyClient(label: string): Promise<{ mfaAccessToken: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId, {
    maxRegisteredInstances: 5,
    maxConnectedInstances: 5,
  });
  createdPlanIds.push(planId);
  return { mfaAccessToken };
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

describe('POST /v1/instances/:id/resume validation (P16 fix round)', () => {
  it('a_non_uuid_instance_id_returns_a_mapped_400_never_a_500', async () => {
    // WARNING 6 fix: a garbage :id must be validated at the route before it
    // ever reaches a Postgres uuid-cast comparison - the mapped
    // VALIDATION_ERROR envelope (400), never an unmapped INTERNAL 500.
    const { mfaAccessToken } = await readyClient('resume-bad-id');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/instances/not-a-uuid/resume',
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('a_free_text_resume_reason_with_a_long_digit_run_is_redacted_in_audit_metadata', async () => {
    // WARNING 7 fix: a free-text `reason` carrying a phone-shaped digit run
    // (>= 10 digits) must never land verbatim in audit_logs.metadata.
    const { mfaAccessToken } = await readyClient('resume-redact');
    const instanceId = await createInstance(mfaAccessToken, 'resume-redact-instance');
    await pauseForRestriction(instanceId);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { acknowledgement: true, reason: 'confirmed by phone +919812345678' },
    });
    expect(response.statusCode).toBe(200);

    const audit = await pool.query<{ metadata: { reason: string | null } }>(
      `SELECT metadata FROM audit_logs WHERE target_id = $1 AND action = 'instance.resume'`,
      [instanceId],
    );
    const reason = audit.rows[0]?.metadata.reason ?? '';
    expect(reason).not.toMatch(/\d{10,}/);
    expect(reason).toContain('confirmed by phone');
  });
});
