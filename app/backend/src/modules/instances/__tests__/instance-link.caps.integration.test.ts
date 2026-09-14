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
 * instance-link.caps.integration.test.ts (P08 Unit U6c) - the connected-slot
 * (NO_FREE_SLOT) and pairing-window-exhaustion (link/refresh INVALID_STATE)
 * cap tests, split from instance-link.routes.integration.test.ts for
 * max-lines.
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

describe('online() connected-slot cap', () => {
  it('reonlining_the_already_online_instance_at_a_full_cap_is_idempotent_200_not_409', async () => {
    // FIX BATCH B / B1 regression: setOnlineWithSlotCheck used to count ALL
    // online rows including the instance being onlined, so re-onlining an
    // already-online instance under a full cap returned 409 NO_FREE_SLOT
    // naming ITSELF as the blocker. The short-circuit (already online ->
    // ok no-op) plus the others-excluding count must both prevent that.
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'reonline-full-cap',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 1,
    });
    createdPlanIds.push(planId);

    const holder = await createInstance(mfaAccessToken, 'sole-holder');
    const firstOnline = await app.inject({
      method: 'POST',
      url: `/v1/instances/${holder.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(firstOnline.statusCode).toBe(200);

    const secondOnline = await app.inject({
      method: 'POST',
      url: `/v1/instances/${holder.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(secondOnline.statusCode).toBe(200);
    expect(secondOnline.json().data).toEqual({ desiredState: 'online' });

    const row = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [holder.id],
    );
    expect(row.rows[0]?.desired_state).toBe('online');

    // FIX ROUND 2 FIX 2 regression: the idempotent no-op re-online call must
    // NEVER append a second 'instance.online' audit row - exactly one audit
    // row survives both calls.
    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE target_id = $1 AND action = 'instance.online'`,
      [holder.id],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it('onlining_a_second_instance_at_cap_one_still_409s_naming_the_real_holder', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'second-instance-still-blocked',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 1,
    });
    createdPlanIds.push(planId);

    const holder = await createInstance(mfaAccessToken, 'real-holder');
    const holderOnline = await app.inject({
      method: 'POST',
      url: `/v1/instances/${holder.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(holderOnline.statusCode).toBe(200);

    const second = await createInstance(mfaAccessToken, 'second-instance');
    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/instances/${second.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(blocked.statusCode).toBe(409);
    const blockedBody = blocked.json() as {
      error: { code: string; details?: { holders: { instanceId: string }[] } };
    };
    expect(blockedBody.error.code).toBe('NO_FREE_SLOT');
    expect(blockedBody.error.details?.holders).toEqual([
      expect.objectContaining({ instanceId: holder.id }),
    ]);
  });

  it('online_with_no_free_slot_names_the_holders_and_parks_nothing', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'no-free-slot',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 1,
    });
    createdPlanIds.push(planId);

    const holder = await createInstance(mfaAccessToken, 'holder');
    const holderOnline = await app.inject({
      method: 'POST',
      url: `/v1/instances/${holder.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(holderOnline.statusCode).toBe(200);

    const requester = await createInstance(mfaAccessToken, 'requester');
    const blocked = await app.inject({
      method: 'POST',
      url: `/v1/instances/${requester.id}/online`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(blocked.statusCode).toBe(409);
    const blockedBody = blocked.json() as {
      error: {
        code: string;
        details?: {
          holders: { instanceId: string; label: string | null; maskedNumber: string | null }[];
        };
      };
    };
    expect(blockedBody.error.code).toBe('NO_FREE_SLOT');
    expect(blockedBody.error.details?.holders).toEqual([
      { instanceId: holder.id, label: 'holder', maskedNumber: null },
    ]);

    const requesterRow = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [requester.id],
    );
    expect(requesterRow.rows[0]?.desired_state).toBe('offline');

    const holderRow = await pool.query<{ desired_state: string }>(
      'SELECT desired_state FROM whatsapp_instances WHERE id = $1',
      [holder.id],
    );
    expect(holderRow.rows[0]?.desired_state).toBe('online');
  });
});

describe('link/refresh pairing-window guard', () => {
  it('refresh_after_window_exhaustion_returns_null_and_needs_a_button', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'window-exhaustion',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 5,
    });
    createdPlanIds.push(planId);

    const created = await createInstance(mfaAccessToken, 'exhausted');
    const linkResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { method: 'qr' },
    });
    expect(linkResponse.statusCode).toBe(202);

    // Drive qr_attempts to 6 and mark PAIRING_EXPIRED directly via the repo's
    // own SQL surface (no HTTP route exists for the engine's own increment -
    // that is the runner's job, out of scope here).
    await pool.query(
      `UPDATE whatsapp_instances SET qr_attempts = 6, needs_user_action = true,
         user_action_reason = 'PAIRING_EXPIRED' WHERE id = $1`,
      [created.id],
    );

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/v1/instances/${created.id}/link-status`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(statusResponse.statusCode).toBe(200);
    const statusBody = statusResponse.json().data as {
      attemptsLeft: number;
      userActionReason: string | null;
    };
    expect(statusBody.attemptsLeft).toBe(0);
    expect(statusBody.userActionReason).toBe('PAIRING_EXPIRED');

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link/refresh`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(refreshResponse.statusCode).toBe(200);
    expect(refreshResponse.json().data).toEqual({ challenge: null, linkState: 'pairing' });

    const row = await pool.query<{ qr_attempts: number; user_action_reason: string | null }>(
      'SELECT qr_attempts, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [created.id],
    );
    expect(row.rows[0]?.qr_attempts).toBe(0);
    expect(row.rows[0]?.user_action_reason).toBeNull();
  });

  it('refresh_from_an_illegal_state_returns_invalid_state', async () => {
    const { client, mfaAccessToken } = await onboardedMfaClient(
      app,
      sentVerificationUrls,
      'illegal-refresh',
    );
    createdUserIds.push(client.userId);
    createdClientIds.push(client.clientId);
    const planId = await seedPlanForClient(pool, client.clientId, {
      maxRegisteredInstances: 5,
      maxConnectedInstances: 5,
    });
    createdPlanIds.push(planId);

    // Never linked/paired at all - link_state stays 'unlinked', no
    // user_action_reason - refresh must be illegal from this state.
    const created = await createInstance(mfaAccessToken, 'never-paired');

    const refreshResponse = await app.inject({
      method: 'POST',
      url: `/v1/instances/${created.id}/link/refresh`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
    });
    expect(refreshResponse.statusCode).toBe(409);
    expect((refreshResponse.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE',
    );
  });
});
