import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type HealthEvaluatorCtx } from '../pacing/health/HealthEvaluator.js';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { seedPacingInstance } from '../../engine/pacing/__tests__/pacing-test-helpers.js';
import { claimOne } from '../queue/queue.repo.js';
import { wakeChannel } from '../../engine/queue/wake.js';
import { resumeInstance } from './resume.js';
import { seedLease } from './__tests__/instances-test-helpers.js';
import {
  buildInstancesApp,
  buildTestConfig,
  cleanupInstancesRecords,
  onboardedMfaClient,
  seedPlanForClient,
} from './__tests__/instances-routes-test-support.js';

/**
 * resume.integration.test.ts (P16 Unit D, step 8) - real PG/Redis. Proves
 * the human-only resume contract end to end: pacing invariant 11 (a paused
 * instance never auto-resumes, however many perfect-score evaluator ticks
 * run), the actor guard at the service level for non-user actors, the
 * acknowledgement gate over HTTP, and the wake+audit write on a successful
 * resume.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];
const createdPlanIds: string[] = [];
let probeClientIds: string[] = [];

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
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_health_samples WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  const { cleanupPacingProbeClients } =
    await import('../../engine/pacing/__tests__/pacing-test-helpers.js');
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function testWake(): { publishWake: (clientId: string, instanceId: string) => Promise<void> } {
  return { publishWake: async () => undefined };
}

async function pauseForRestriction(instanceId: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_instances SET health_state = 'paused', pause_reason = 'provider_restriction',
        needs_user_action = true, user_action_reason = 'RESTRICTION_SIGNAL'
      WHERE id = $1`,
    [instanceId],
  );
}

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

describe('POST /v1/instances/:id/resume (P16 Unit D)', () => {
  it('paused_instance_never_auto_resumes', async () => {
    const seeded = await seedPacingInstance(pool, probeClientIds, { healthState: 'paused' });
    await pool.query(
      `UPDATE whatsapp_instances SET pause_reason = 'provider_restriction', needs_user_action = true
        WHERE id = $1`,
      [seeded.instanceId],
    );
    await seedLease(pool, { clientId: seeded.clientId, instanceId: seeded.instanceId, fence: 1 });

    const clock = { current: Date.UTC(2026, 8, 1, 0, 0, 0) };
    const ctx: HealthEvaluatorCtx = {
      sql: pool as never,
      clientId: seeded.clientId,
      clock: { now: () => clock.current },
    };

    // 72 hours of perfect-score ticks, one per hour.
    for (let hour = 0; hour < 72; hour += 1) {
      clock.current += 60 * 60 * 1000;
      const result = await evaluate(ctx, seeded.instanceId);
      expect(result.paused).toBe(true);
    }

    const row = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');

    const claimed = await claimOne(
      { clientId: seeded.clientId, sql: pool as never },
      {
        instanceId: seeded.instanceId,
        band: 3,
        fence: 1,
        workerId: 'resume-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed).toBeUndefined();
  });

  it('api_key_actor_is_rejected_at_resume', async () => {
    const seeded = await seedPacingInstance(pool, probeClientIds, { healthState: 'paused' });

    await expect(
      resumeInstance(
        { tenantDb, ...testWake() },
        {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          actor: { type: 'api_key', apiKeyId: 'key-1' },
        },
      ),
    ).rejects.toMatchObject({ code: 'RESUME_REQUIRES_USER' });

    const row = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');
    const audit = await pool.query('SELECT 1 FROM audit_logs WHERE target_id = $1', [
      seeded.instanceId,
    ]);
    expect(audit.rowCount).toBe(0);
  });

  it('system_actor_is_rejected_at_resume', async () => {
    const seeded = await seedPacingInstance(pool, probeClientIds, { healthState: 'paused' });

    await expect(
      resumeInstance(
        { tenantDb, ...testWake() },
        {
          clientId: seeded.clientId,
          instanceId: seeded.instanceId,
          actor: { type: 'system' },
        },
      ),
    ).rejects.toMatchObject({ code: 'RESUME_REQUIRES_USER' });

    const row = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('paused');
  });

  it('restriction_pause_requires_the_acknowledgement_flag', async () => {
    const { mfaAccessToken } = await readyClient('resume-ack');
    const instanceId = await createInstance(mfaAccessToken, 'resume-ack-instance');
    await pauseForRestriction(instanceId);

    const withoutAck = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: {},
    });
    expect(withoutAck.statusCode).toBe(422);
    expect(withoutAck.json().error.code).toBe('ACKNOWLEDGEMENT_REQUIRED');

    const withAck = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: { acknowledgement: true, reason: 'confirmed with the client' },
    });
    expect(withAck.statusCode).toBe(200);
    expect(withAck.json().data).toEqual({ healthState: 'degraded' });

    const audit = await pool.query<{ metadata: { acknowledgement: boolean } }>(
      `SELECT metadata FROM audit_logs WHERE target_id = $1 AND action = 'instance.resume'`,
      [instanceId],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ acknowledgement: true });
  });

  it('resume_publishes_a_wake_and_writes_actor_user_id', async () => {
    const { mfaAccessToken, clientId } = await readyClient('resume-wake');
    const instanceId = await createInstance(mfaAccessToken, 'resume-wake-instance');
    await pool.query(
      `UPDATE whatsapp_instances SET health_state = 'paused', pause_reason = 'reconnect_failed',
          needs_user_action = true WHERE id = $1`,
      [instanceId],
    );

    const channel = wakeChannel(buildTestConfig().NODE_ENV, clientId, instanceId);
    const subscriber = redis.duplicate();
    await subscriber.subscribe(channel);
    // Deterministic wait: resolves the moment the SAME code path that
    // commits the resume transaction (resume.ts's own doc: wake publish
    // runs strictly after commit, same code path) delivers a real Redis
    // pub/sub message on this exact channel - no wall-clock sleep/margin
    // (same discipline as wake.integration.test.ts's own
    // `a_wake_for_another_tenants_instance_never_triggers_a_claim`, which
    // uses `redis.publish`'s synchronous receiver-count return instead of a
    // timer; here the event itself, not a count, is the awaited fact).
    const receivedChannel = new Promise<string>((resolve) => {
      subscriber.on('message', (ch) => resolve(ch));
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/resume`,
      headers: { authorization: `Bearer ${mfaAccessToken}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);

    await expect(receivedChannel).resolves.toBe(channel);
    await subscriber.unsubscribe(channel);
    await subscriber.quit();

    const audit = await pool.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_logs WHERE target_id = $1 AND action = 'instance.resume'`,
      [instanceId],
    );
    expect(audit.rows[0]?.actor_user_id).not.toBeNull();
  });
});
