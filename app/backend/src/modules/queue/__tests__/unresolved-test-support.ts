import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { onboardedMfaClient, seedPlanForClient } from '../../messages/enqueue-test-support.js';

/**
 * __tests__/unresolved-test-support.ts (P12 Unit U5) - shared seed helpers
 * for `unresolved-api.integration.test.ts` and
 * `unresolved-no-auto-requeue.integration.test.ts` (split at the max-lines
 * cap). Lives under `__tests__/` (not a `routes.ts`-style sibling) so its
 * raw seed INSERTs fall under `check-tenant-scope.ts`'s own `__tests__/`
 * exemption (`TEST_FILE_PATTERN`), the same convention
 * `engine/queue/__tests__/queue-send-test-helpers.ts` already uses. NOT
 * itself a test file (no `.test.ts` suffix).
 */

export interface SeededUnresolvedJob {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  publicId: string;
}

/** Seeds a claimed job, marks its attempt `dispatched`, then moves the job into `blocked_needs_review` - the exact state a human sees the two-choice panel entry for. */
export async function seedUnresolvedJob(
  pool: TestPool,
  probeClientIds: string[],
): Promise<SeededUnresolvedJob> {
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
  return {
    clientId,
    instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    publicId: job.publicId,
  };
}

export interface ReadyUnresolvedClient {
  mfaAccessToken: string;
  clientId: string;
  publicId: string;
  jobId: string;
}

/** Onboards a real client via HTTP, then seeds an unresolved job directly under that same client id. */
export async function readyClientWithUnresolvedJob(
  app: FastifyInstance,
  pool: TestPool,
  sentVerificationUrls: Map<string, string>,
  createdUserIds: string[],
  createdClientIds: string[],
  createdPlanIds: string[],
  label: string,
): Promise<ReadyUnresolvedClient> {
  const { client, mfaAccessToken } = await onboardedMfaClient(app, sentVerificationUrls, label);
  createdUserIds.push(client.userId);
  createdClientIds.push(client.clientId);
  const planId = await seedPlanForClient(pool, client.clientId);
  createdPlanIds.push(planId);

  // The job is seeded directly under the onboarded client's own id (not a
  // second probe tenant) - simpler than re-pointing a probe-tenant job at a
  // different client_id after the fact, and avoids fighting RLS/FK
  // consistency the way a post-hoc UPDATE would.
  const instanceId = randomUUID();
  await pool.query(
    `INSERT INTO whatsapp_instances (id, client_id, label, health_state, session_epoch)
     VALUES ($1, $2, 'unresolved-probe', 'connected', 0)`,
    [instanceId, client.clientId],
  );
  await pool.query(
    'INSERT INTO instance_lease_state (instance_id, client_id, current_fence) VALUES ($1, $2, 1)',
    [instanceId, client.clientId],
  );

  const job = await seedClaimedJob(pool, { clientId: client.clientId, instanceId });
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id, attempt_no, state, prepared_at, dispatched_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'dispatched', now(), now())`,
    [client.clientId, instanceId, job.id, job.createdAt, job.leaseId],
  );
  await pool.query(
    `UPDATE message_jobs SET status = 'blocked_needs_review', needs_user_action = true,
            unresolved_reason = 'no_echo_evidence', unresolved_at = now(),
            lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL
      WHERE id = $1 AND client_id = $2`,
    [job.id, client.clientId],
  );

  return {
    mfaAccessToken,
    clientId: client.clientId,
    publicId: job.publicId,
    jobId: job.id,
  };
}
