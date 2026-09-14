import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { enqueueMessageJob } from './messages.repo.js';
import {
  buildMessagesApp,
  buildTestConfig,
  cleanupMessagesRecords,
  onboardedMfaClient,
  seedInstance,
  seedPlanForClient,
} from './enqueue-test-support.js';

/**
 * enqueue.integration.test.ts (P11 Unit U3) - mandatory suite, exact case
 * names, real Postgres + real `buildApp`. `the_api_process_cannot_reach_the_
 * transport` lives in the enqueue.api-boundary sibling (max-lines split).
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
  app = await buildMessagesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

afterAll(async () => {
  await app.close();
  await cleanupMessagesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

async function readyClientWithInstance(
  label: string,
  instanceOptions: { linkState?: string; healthState?: string } = {},
): Promise<{ mfaAccessToken: string; clientId: string; instanceId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId);
  createdPlanIds.push(planId);
  const instanceId = await seedInstance(pool, client.clientId, instanceOptions);
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

describe('POST /v1/messages - enqueue transaction', () => {
  it('duplicate_idempotency_key_creates_one_job', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('dup-key');
    const idempotencyKey = `idem-${randomUUID()}`;
    const payload = validPayload();
    // A shared x-request-id makes the response body's own meta.requestId
    // (present by canon on every response, per-request by design) equal
    // across all 50 calls too - the only way for "50 identical response
    // bodies" to be a meaningful, exact-value assertion rather than one
    // that ignores a field the envelope always carries.
    const requestId = `req-${randomUUID()}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.inject({
          method: 'POST',
          url: messagesUrl(instanceId),
          headers: {
            authorization: `Bearer ${mfaAccessToken}`,
            'idempotency-key': idempotencyKey,
            'x-request-id': requestId,
          },
          payload,
        }),
      ),
    );

    // Zero 5xx - this is exactly what the DO NOTHING gotcha would violate.
    const serverErrors = responses.filter((r) => r.statusCode >= 500);
    expect(serverErrors).toHaveLength(0);

    // All 50 response bodies are byte-identical.
    const bodies = responses.map((r) => r.body);
    expect(new Set(bodies).size).toBe(1);

    // Exactly one message_jobs row exists for this client.
    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(1);

    // Exactly one message_job_refs row for this idempotency key.
    const refs = await pool.query(
      'SELECT public_id FROM message_job_refs WHERE client_id = $1 AND idempotency_key = $2',
      [clientId, idempotencyKey],
    );
    expect(refs.rows).toHaveLength(1);
  });

  it('same_key_different_body_is_rejected_with_409', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('key-reuse');
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': idempotencyKey },
      payload: validPayload(),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': idempotencyKey },
      payload: validPayload({ payload: { text: 'a different body entirely' } }),
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(1);
  });

  it('enqueue_writes_job_ref_and_two_events_in_one_transaction', async () => {
    // Calls the repo directly so an injected failure fires AFTER
    // enqueueMessageJob has written job+ref+both event pairs, but BEFORE
    // the surrounding withTenant transaction commits - withTenant rolls
    // back on any throw, proving zero residue from a mid-transaction
    // failure (the general form is no_job_row_ever_exists_without_a_
    // matching_ref below, at scale under real HTTP concurrency).
    const { clientId, instanceId } = await readyClientWithInstance('atomic-fail');
    const idempotencyKey = `idem-${randomUUID()}`;

    await expect(
      tenantDb.withTenant(clientId, async (tx) => {
        await enqueueMessageJob(tx, {
          clientId,
          instanceId,
          idempotencyKey,
          requestHash: Buffer.from('hash-1'),
          recipient: { jid: '919876543210@s.whatsapp.net', e164: '+919876543210' },
          recipientHash: Buffer.from('recipient-hash-1'),
          sendOrigin: 'api_send',
          payload: { text: 'hi' },
          payloadKind: 'text',
          priority: 'normal',
          scheduledAt: null,
        });
        // Injected failure: violates delivery_events' own de_detail_size
        // CHECK directly on the transaction's connection, forcing the
        // withTenant callback to throw and roll back everything above.
        await tx.query(
          `INSERT INTO delivery_events (client_id, instance_id, event_type, detail)
           VALUES ($1, $2, 'created', $3)`,
          [clientId, instanceId, JSON.stringify({ text: 'x'.repeat(300) })],
        );
      }),
    ).rejects.toThrow();

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(0);
    const refs = await pool.query('SELECT public_id FROM message_job_refs WHERE client_id = $1', [
      clientId,
    ]);
    expect(refs.rows).toHaveLength(0);
    const events = await pool.query('SELECT id FROM delivery_events WHERE client_id = $1', [
      clientId,
    ]);
    expect(events.rows).toHaveLength(0);
  });

  it('no_job_row_ever_exists_without_a_matching_ref', async () => {
    const { mfaAccessToken, instanceId } = await readyClientWithInstance('fuzz-500');

    const responses = await Promise.all(
      Array.from({ length: 500 }, () =>
        app.inject({
          method: 'POST',
          url: messagesUrl(instanceId),
          headers: {
            authorization: `Bearer ${mfaAccessToken}`,
            'idempotency-key': `idem-${randomUUID()}`,
          },
          payload: validPayload(),
        }),
      ),
    );
    const serverErrors = responses.filter((r) => r.statusCode >= 500);
    expect(serverErrors).toHaveLength(0);

    // Schema-level assertion over the WHOLE table (not just this test's own
    // rows) - the invariant this transaction exists to prove.
    const orphans = await pool.query(
      `SELECT j.id FROM message_jobs j
        LEFT JOIN message_job_refs r
          ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE r.public_id IS NULL`,
    );
    expect(orphans.rows).toHaveLength(0);
  });

  it('an_offline_instance_returns_202_with_instance_offline_and_still_queues', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('offline', {
      linkState: 'linked',
      healthState: 'degraded',
    });

    const response = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: {
        authorization: `Bearer ${mfaAccessToken}`,
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { data: { id: string; status: string; warning?: string } };
    expect(body.data.status).toBe('queued');
    expect(body.data.warning).toBe('INSTANCE_OFFLINE');

    const job = await pool.query('SELECT status FROM message_jobs WHERE client_id = $1', [
      clientId,
    ]);
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]?.status).toBe('queued');
  });

  it('an_unlinked_instance_returns_409_and_creates_no_job', async () => {
    const { mfaAccessToken, instanceId, clientId } = await readyClientWithInstance('unlinked', {
      linkState: 'unlinked',
      healthState: 'never_linked',
    });

    const response = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: {
        authorization: `Bearer ${mfaAccessToken}`,
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('INSTANCE_UNLINKED');

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [clientId]);
    expect(jobs.rows).toHaveLength(0);
  });

  it('another_tenants_instance_id_yields_404_and_creates_no_job', async () => {
    const owner = await readyClientWithInstance('owner-of-instance');
    const other = await readyClientWithInstance('other-tenant');

    const response = await app.inject({
      method: 'POST',
      url: messagesUrl(owner.instanceId),
      headers: {
        authorization: `Bearer ${other.mfaAccessToken}`,
        'idempotency-key': `idem-${randomUUID()}`,
      },
      payload: validPayload(),
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');

    const jobs = await pool.query('SELECT id FROM message_jobs WHERE client_id = $1', [
      other.clientId,
    ]);
    expect(jobs.rows).toHaveLength(0);
  });
});
