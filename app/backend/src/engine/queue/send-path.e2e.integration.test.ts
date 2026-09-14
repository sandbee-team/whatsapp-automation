import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createDwrrSelector } from '@wp/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import {
  buildMessagesApp,
  buildTestConfig,
  cleanupMessagesRecords,
  onboardedMfaClient,
} from '../../modules/messages/enqueue-test-support.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { runOneSendLoopIteration } from './send-loop.js';
import type { TestPool } from './__tests__/queue-send-test-helpers.js';
import {
  orderedDeliveryEvents,
  sendLoopDepsUsing,
} from './__tests__/send-path-e2e-test-support.js';

/**
 * send-path.e2e.integration.test.ts (P11 Unit U6b) - the fake-transport
 * happy-path half of step 10's end-to-end proof: composes U3's real HTTP
 * enqueue route, the real `claimOne()` (P03), U4's real
 * `dispatch`/`result` transactions, and U5's `runOneSendLoopIteration`
 * driver, against real Postgres, with only the WhatsApp PROVIDER faked
 * (`createFakeTransport`). The DWRR-fairness and instance-isolation cases
 * live in the `send-path-fairness`/`send-path-isolation` siblings (300-line
 * cap split, shared wiring in `__tests__/send-path-e2e-test-support.ts`).
 * The live-number smoke half of step 10 is deliberately deferred (founder
 * decision, recorded in `.memory/progress/master-plan.md`) - not attempted
 * here.
 *
 * No production module is modified by this unit - every piece composed
 * below already landed green in U1-U5.
 */

let pool: TestPool;
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
    applicationName: 'send-path-e2e-test',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  const config = buildTestConfig();
  app = await buildMessagesApp({ pool, tenantDb, redis, config, sentVerificationUrls });
});

/**
 * `cleanupMessagesRecords` (the enqueue-suite's own helper, reused here per
 * the dispatch instructions) never deletes `send_attempts`/`message_wa_ids`
 * (U4 additions it predates) or `instance_lease_state` (this file's own
 * addition, needed for `claimOne`'s fence predicate) - deleted here FIRST,
 * in FK order, before delegating the rest (memberships/wallet/users/etc.)
 * to it.
 */
afterAll(async () => {
  await app.close();
  if (createdClientIds.length > 0) {
    await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM message_wa_ids WHERE client_id = ANY($1)', [createdClientIds]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      createdClientIds,
    ]);
  }
  await cleanupMessagesRecords(pool, redis, createdUserIds, createdClientIds, createdPlanIds);
  redis.disconnect();
  await pool.end();
});

/**
 * Same shape as enqueue.integration.test.ts's own `readyClientWithInstance`,
 * but ALSO inserts `instance_lease_state` (the real HTTP signup/onboarding
 * path never does - that row is `claimOne`'s own fence-ownership concern,
 * seeded directly here exactly as `queue-send-test-helpers.ts#seedSendTenant`
 * does for its own probes).
 */
async function readySendableClient(
  label: string,
  fence = 1,
): Promise<{ mfaAccessToken: string; clientId: string; instanceId: string }> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);

  const planId = randomUUID();
  await pool.query('INSERT INTO plans (id, name) VALUES ($1, $2)', [
    planId,
    `Send Path Plan ${planId}`,
  ]);
  await pool.query(
    `INSERT INTO plan_limits (plan_id, max_connected_instances, max_registered_instances)
     VALUES ($1, 5, 5)`,
    [planId],
  );
  await pool.query('UPDATE clients SET plan_id = $1 WHERE id = $2', [planId, client.clientId]);
  createdPlanIds.push(planId);

  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, link_state, health_state)
     VALUES ($1, $2, 'send-path-e2e', 'linked', 'connected')`,
    [instanceId, client.clientId],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, $3)',
    [instanceId, client.clientId, fence],
  );

  return { mfaAccessToken, clientId: client.clientId, instanceId };
}

function messagesUrl(instanceId: string): string {
  return `/v1/messages?instanceId=${instanceId}`;
}

describe('send-path e2e (fake transport, real Postgres) - P11 U6b', () => {
  it('a_posted_message_is_claimed_dispatched_and_recorded_end_to_end', async () => {
    const { mfaAccessToken, clientId, instanceId } = await readySendableClient('e2e-happy');

    const idempotencyKey = `idem-${randomUUID()}`;
    const response = await app.inject({
      method: 'POST',
      url: messagesUrl(instanceId),
      headers: { authorization: `Bearer ${mfaAccessToken}`, 'idempotency-key': idempotencyKey },
      payload: {
        kind: 'text',
        recipient: '+919876543210',
        payload: { text: 'end to end' },
        priority: 'normal',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { data: { id: string; status: string } };
    expect(body.data.status).toBe('queued');

    // Job is durably 'queued' right after the POST (before any claim runs) -
    // durable-first, core invariant 1.
    const preClaim = await pool.query<{ status: string }>(
      `SELECT j.status FROM message_jobs j
         JOIN message_job_refs r ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE r.public_id = $1`,
      [body.data.id],
    );
    expect(preClaim.rows[0]?.status).toBe('queued');

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.e2e-happy-1');
    const dwrr = createDwrrSelector();

    const iterationResult = await runOneSendLoopIteration(
      sendLoopDepsUsing(pool, tenantDb, clientId, instanceId, 1, transport, dwrr),
    );
    expect(iterationResult).toEqual({ claimed: true });

    const jobRow = await pool.query<{ status: string; attempts: number }>(
      `SELECT j.status, j.attempts FROM message_jobs j
         JOIN message_job_refs r ON r.message_job_id = j.id AND r.message_job_created_at = j.created_at
        WHERE r.public_id = $1`,
      [body.data.id],
    );
    expect(jobRow.rows[0]?.status).toBe('sent');
    expect(jobRow.rows[0]?.attempts).toBe(1);

    // The lifecycle writes exactly FOUR delivery_events rows, in this exact
    // order: 'created'/'queued' (both from U3's enqueue transaction),
    // 'dispatched' (U4's dispatch transaction), 'sent' (U4's ack write).
    // NOT five: no code path anywhere in the composed system writes a
    // 'claimed' delivery_events row (claimOne's own UPDATE ... RETURNING
    // never calls writeDeliveryEvent) - the phase table's "five" is not
    // what the system actually does; asserted exactly as observed, not
    // weakened to "at least four".
    const events = await orderedDeliveryEvents(pool, clientId);
    expect(events).toEqual(['created', 'queued', 'dispatched', 'sent']);

    const attempts = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM send_attempts WHERE client_id = $1',
      [clientId],
    );
    expect(attempts.rows[0]?.count).toBe('1');

    const waIds = await pool.query<{ wa_msg_id: string }>(
      'SELECT wa_msg_id FROM message_wa_ids WHERE client_id = $1',
      [clientId],
    );
    expect(waIds.rows).toHaveLength(1);
    expect(waIds.rows[0]?.wa_msg_id).toBe('wamid.e2e-happy-1');
  });
});
