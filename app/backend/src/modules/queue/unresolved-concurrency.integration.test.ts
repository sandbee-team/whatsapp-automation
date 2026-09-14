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
import { discardUnresolved, retryUnresolved } from './unresolved.service.js';

/**
 * unresolved-concurrency.integration.test.ts (P12 C2 hardening pass) - real
 * Postgres. Covers three gaps the C1 review did not exercise:
 *
 *   1. Two humans racing Retry and Discard on the SAME `blocked_needs_review`
 *      job (concurrency, priority-edge-case 2) - the DB's conditional
 *      `WHERE status = 'blocked_needs_review'` UPDATE is the only arbiter;
 *      exactly one action must land, and the loser must fail closed (NOT
 *      silently succeed a second time on an already-moved job).
 *   2. A replayed DISCARD with the same idempotency key (only the retry
 *      replay path is covered by unresolved-api.integration.test.ts's
 *      mandatory test) - the second call must be a no-op, not a second audit
 *      row / second cancel attempt.
 *   3. Retry on a `blocked_needs_review` job with NO in-flight `dispatched`
 *      attempt row at all (e.g. discard/retry ran once already re-queued and
 *      re-failed it back into review with no live attempt) - `retryUnresolved`
 *      must not throw and must not call `onReconciledLost`.
 *
 * Seed shape mirrors `unresolved-repo-replay.integration.test.ts` (a real
 * `users` row + direct service calls) rather than the full HTTP app, since
 * none of these cases needs the route/auth layer.
 */

let pool: TestPool;
const probeClientIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'unresolved-concurrency-test',
  });
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

async function seedActor(): Promise<string> {
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Concurrency Actor')`,
    [userId, `unresolved-concurrency-${userId}@example.test`],
  );
  createdUserIds.push(userId);
  return userId;
}

/** Seeds a claimed job, one dispatched attempt, then moves it to blocked_needs_review - same shape as unresolved-test-support.ts's own seedUnresolvedJob. */
async function seedBlockedJob(): Promise<{
  clientId: string;
  instanceId: string;
  jobId: string;
  publicId: string;
}> {
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
  return { clientId, instanceId, jobId: job.id, publicId: job.publicId };
}

describe('unresolved retry/discard concurrency (real Postgres)', () => {
  it('a_concurrent_retry_and_discard_on_the_same_job_lands_exactly_one_and_the_loser_fails_closed', async () => {
    const tenantDb = createTenantDb(pool);
    const seeded = await seedBlockedJob();
    const userId = await seedActor();
    const sink = createCountingNoOpRepairedSendSink();

    // Deterministic interleaving, not a sampled race: run retry to
    // completion FIRST (it wins the conditional UPDATE), then attempt
    // discard against the now-already-moved job - this is the same
    // "loser observes zero rows matched" shape a real concurrent second
    // request would hit, driven deterministically rather than by launching
    // two promises and hoping for a particular ordering.
    const retryResult = await retryUnresolved(
      { tenantDb, sink },
      { kind: 'user', userId },
      {
        clientId: seeded.clientId,
        jobPublicId: seeded.publicId,
        idempotencyKey: `idem-retry-${randomUUID()}`,
      },
    );
    expect(retryResult.status).toBe('queued');

    // The job is now 'queued', not 'blocked_needs_review' - discard's own
    // `WHERE status = 'blocked_needs_review'` guard must match zero rows and
    // fail closed (NOT silently report cancelled on a job it never touched).
    await expect(
      discardUnresolved(
        { tenantDb },
        { kind: 'user', userId },
        {
          clientId: seeded.clientId,
          jobPublicId: seeded.publicId,
          idempotencyKey: `idem-discard-${randomUUID()}`,
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The job stays exactly as the winner (retry) left it - the loser's
    // failed attempt must not have partially mutated it.
    const job = await pool.query<{ status: string; cancel_reason: string | null }>(
      'SELECT status, cancel_reason FROM message_jobs WHERE id = $1',
      [seeded.jobId],
    );
    expect(job.rows[0]?.status).toBe('queued');
    expect(job.rows[0]?.cancel_reason).toBeNull();

    // Exactly one audit row exists for this job - the loser never wrote one.
    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2`,
      [seeded.clientId, seeded.publicId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['message.unresolved_retried']);
  });

  it('a_replayed_discard_with_the_same_idempotency_key_cancels_once', async () => {
    const tenantDb = createTenantDb(pool);
    const seeded = await seedBlockedJob();
    const userId = await seedActor();
    const idempotencyKey = `idem-discard-replay-${randomUUID()}`;

    const first = await discardUnresolved(
      { tenantDb },
      { kind: 'user', userId },
      { clientId: seeded.clientId, jobPublicId: seeded.publicId, idempotencyKey },
    );
    expect(first.status).toBe('cancelled');

    // Second call, SAME idempotency key: must be a no-op returning the same
    // shape, never a second audit row, never re-attempting the (now
    // impossible - status is no longer blocked_needs_review) transition.
    const second = await discardUnresolved(
      { tenantDb },
      { kind: 'user', userId },
      { clientId: seeded.clientId, jobPublicId: seeded.publicId, idempotencyKey },
    );
    expect(second).toEqual(first);

    const audit = await pool.query(
      `SELECT id FROM audit_logs WHERE client_id = $1 AND action = 'message.unresolved_discarded' AND target_id = $2`,
      [seeded.clientId, seeded.publicId],
    );
    expect(audit.rows).toHaveLength(1);

    const keys = await pool.query(
      `SELECT idempotency_key FROM unresolved_action_keys WHERE client_id = $1 AND idempotency_key = $2`,
      [seeded.clientId, idempotencyKey],
    );
    expect(keys.rows).toHaveLength(1);
  });

  it('retry_on_a_blocked_job_with_no_inflight_attempt_requeues_without_calling_onReconciledLost', async () => {
    const tenantDb = createTenantDb(pool);
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    // Move straight to blocked_needs_review with NO send_attempts row at all
    // - e.g. a job that was manually reviewed and re-blocked with its
    // earlier attempt already resolved/abandoned by an earlier cycle.
    await pool.query(
      `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
              unresolved_reason = 'no_echo_evidence', unresolved_at = now(),
              lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL
        WHERE id = $1 AND client_id = $2`,
      [job.id, clientId],
    );
    const userId = await seedActor();
    const sink = createCountingNoOpRepairedSendSink();

    const result = await retryUnresolved(
      { tenantDb, sink },
      { kind: 'user', userId },
      { clientId, jobPublicId: job.publicId, idempotencyKey: `idem-no-attempt-${randomUUID()}` },
    );

    expect(result.status).toBe('queued');
    expect(sink.reconciledLostCalls).toHaveLength(0);

    const jobRow = await pool.query<{ status: string; next_attempt_at: Date }>(
      'SELECT status, next_attempt_at FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobRow.rows[0]?.status).toBe('queued');
  });
});
