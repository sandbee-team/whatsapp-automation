import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';
import { retryUnresolved } from './unresolved.service.js';

/**
 * debug-temp.integration.test.ts (P12 Unit U5) - narrow regression proof
 * for the `recordActionKeyOrReplay` fix (`unresolved-repo.ts`): a FRESH
 * idempotency key must never be misclassified as a replay. `ON CONFLICT
 * (...) DO UPDATE SET action = unresolved_action_keys.action RETURNING
 * action` returns the SAME action value on both a genuine first insert and
 * a genuine replay - `row.action === input.action` alone cannot tell them
 * apart, which is exactly the bug this test caught (a fresh call was
 * short-circuited as if it were a replay, silently skipping the whole
 * state transition while still returning a fabricated success). The fix
 * uses Postgres's own `xmax = 0` tell instead - see that module's doc
 * comment for the full explanation.
 */

let pool: TestPool;
const probeClientIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'unresolved-repo-debug',
  });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('unresolved-repo replay detection (regression)', () => {
  it('a_fresh_idempotency_key_is_never_misclassified_as_a_replay', async () => {
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id, attempt_no, state, prepared_at, dispatched_at)
       VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
      [clientId, instanceId, job.id, job.createdAt, job.leaseId],
    );
    await pool.query(
      `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
              unresolved_reason = 'no_echo_evidence', unresolved_at = now(),
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL
        WHERE id = $1 AND client_id = $2`,
      [job.id, clientId],
    );

    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Regression Actor')`,
      [userId, `unresolved-regression-${userId}@example.test`],
    );
    createdUserIds.push(userId);

    const sink = createCountingNoOpRepairedSendSink();
    await retryUnresolved(
      { tenantDb, sink },
      { kind: 'user', userId },
      { clientId, jobPublicId: job.publicId, idempotencyKey: `idem-${randomUUID()}` },
    );

    const jobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1 AND client_id = $2',
      [job.id, clientId],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');

    const audit = await pool.query(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'message.unresolved_retried'`,
      [clientId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(sink.reconciledLostCalls).toHaveLength(1);
  });
});
