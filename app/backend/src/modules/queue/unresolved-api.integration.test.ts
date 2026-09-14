import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  cleanupSendProbeClients,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';
import { retryUnresolved } from './unresolved.service.js';
import {
  readyClientWithUnresolvedJob,
  seedUnresolvedJob,
} from './__tests__/unresolved-test-support.js';
import {
  buildMessagesApp,
  buildTestConfig,
  cleanupMessagesRecords,
} from '../messages/enqueue-test-support.js';

/**
 * unresolved-api.integration.test.ts (P12 Unit U5) - mandatory test suite
 * (phase file table, exact case names). Real Postgres + a real Fastify app
 * booted through `buildApp` (same shape `roles/api.ts` wires in
 * production). `.integration.test.ts` suffix required - see this unit's own
 * dispatch note on `app/backend/vitest.config.ts` claiming only that
 * suffix. The 72-simulated-hour no-auto-requeue test lives in the sibling
 * `unresolved-no-auto-requeue.integration.test.ts` (max-lines split); seed
 * helpers live in the `unresolved-test-support.ts` sibling both files share.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
const sentVerificationUrls = new Map<string, string>();

const probeClientIds: string[] = [];
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
  app = await buildMessagesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  // `readyClientWithUnresolvedJob` seeds an `instance_lease_state` row for
  // the SAME client id `cleanupMessagesRecords` owns - that table's own FK
  // to `whatsapp_instances` means the lease-state rows must be deleted
  // BEFORE `cleanupMessagesRecords` deletes `whatsapp_instances` directly
  // (that helper has no lease-state step of its own, unlike
  // `cleanupSendProbeClients`, which this suite deliberately does not call
  // for `createdClientIds` - those ids are cleaned up by
  // `cleanupMessagesRecords` instead, all the way down to `clients`).
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM unresolved_action_keys WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
    await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
  }
  await cleanupMessagesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM unresolved_action_keys WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  redis.disconnect();
  await pool.end();
});

describe('POST /v1/messages/:id/unresolved/retry and .../discard', () => {
  it('retry_and_discard_require_a_user_actor_and_write_an_audit_row', async () => {
    const seeded = await seedUnresolvedJob(pool, probeClientIds);
    const sink = createCountingNoOpRepairedSendSink();
    const userId = randomUUID();

    await expect(
      retryUnresolved(
        { tenantDb, sink },
        { kind: 'api_key' },
        {
          clientId: seeded.clientId,
          jobPublicId: seeded.publicId,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      retryUnresolved(
        { tenantDb, sink },
        { kind: 'system' },
        {
          clientId: seeded.clientId,
          jobPublicId: seeded.publicId,
          idempotencyKey: `idem-${randomUUID()}`,
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A real audit-log actor requires a real users row (FK).
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name)
       VALUES ($1, $2, 'x', 'Unresolved Actor')`,
      [userId, `unresolved-actor-${userId}@example.test`],
    );
    createdUserIds.push(userId);

    const result = await retryUnresolved(
      { tenantDb, sink },
      { kind: 'user', userId },
      {
        clientId: seeded.clientId,
        jobPublicId: seeded.publicId,
        idempotencyKey: `idem-${randomUUID()}`,
      },
    );
    expect(result.status).toBe('queued');

    const audit = await pool.query<{ actor_user_id: string; action: string }>(
      `SELECT actor_user_id, action FROM audit_logs
        WHERE client_id = $1 AND action = 'message.unresolved_retried'`,
      [seeded.clientId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor_user_id).toBe(userId);
    expect(sink.reconciledLostCalls).toHaveLength(1);
  });

  it('discard_cancels_and_never_fails_or_deletes_the_job', async () => {
    const seeded = await readyClientWithUnresolvedJob(
      app,
      pool,
      sentVerificationUrls,
      createdUserIds,
      createdClientIds,
      createdPlanIds,
      'discard',
    );

    const response = await app.inject({
      method: 'POST',
      url: `/v1/messages/${seeded.publicId}/unresolved/discard`,
      headers: {
        authorization: `Bearer ${seeded.mfaAccessToken}`,
        'idempotency-key': `idem-${randomUUID()}`,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { id: string; status: string } };
    expect(body.data.status).toBe('cancelled');

    const job = await pool.query<{ status: string; cancel_reason: string | null }>(
      'SELECT status, cancel_reason FROM message_jobs WHERE id = $1 AND client_id = $2',
      [seeded.jobId, seeded.clientId],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.status).toBe('cancelled');
    expect(job.rows[0]?.cancel_reason).toBe('unresolved_discarded');
  });

  it('a_replayed_retry_with_the_same_idempotency_key_requeues_once', async () => {
    const seeded = await readyClientWithUnresolvedJob(
      app,
      pool,
      sentVerificationUrls,
      createdUserIds,
      createdClientIds,
      createdPlanIds,
      'replay',
    );
    const idempotencyKey = `idem-${randomUUID()}`;
    // A shared x-request-id makes the response body's own meta.requestId
    // equal across both calls too - the only way for "identical response
    // bodies" to be an exact-value assertion (same idiom as
    // enqueue.integration.test.ts's duplicate_idempotency_key_creates_one_job).
    const requestId = `req-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: `/v1/messages/${seeded.publicId}/unresolved/retry`,
      headers: {
        authorization: `Bearer ${seeded.mfaAccessToken}`,
        'idempotency-key': idempotencyKey,
        'x-request-id': requestId,
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/v1/messages/${seeded.publicId}/unresolved/retry`,
      headers: {
        authorization: `Bearer ${seeded.mfaAccessToken}`,
        'idempotency-key': idempotencyKey,
        'x-request-id': requestId,
      },
    });
    expect(second.statusCode).toBe(200);
    expect(new Set([first.body, second.body]).size).toBe(1);

    const attempts = await pool.query<{ state: string }>(
      `SELECT state FROM send_attempts WHERE client_id = $1 AND state = 'reconciled_lost'`,
      [seeded.clientId],
    );
    expect(attempts.rows).toHaveLength(1);

    const keys = await pool.query(
      `SELECT idempotency_key FROM unresolved_action_keys WHERE client_id = $1 AND idempotency_key = $2`,
      [seeded.clientId, idempotencyKey],
    );
    expect(keys.rows).toHaveLength(1);
  });
});
