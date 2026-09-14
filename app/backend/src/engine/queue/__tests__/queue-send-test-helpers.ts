import { randomUUID } from 'node:crypto';
import type { createTenantDb } from '@wp/db';
import { claimOne } from '../../../modules/queue/queue.repo.js';
import { createRedis, resolveRedisUrl, tenantKey, sysKey } from '../../../platform/redis.js';
import { seedSendTenant, type TestPool } from './queue-send-tenant-fixture.js';

/**
 * queue-send-test-helpers.ts (P11 Unit U4) - shared, non-test fixture
 * machinery for `dispatch.integration.test.ts` / `result.integration.test.ts`.
 * Mirrors `modules/queue/__tests__/claim-test-helpers.ts`'s shape exactly
 * (own pool/probeClientIds per caller, no shared module-level singleton).
 * Lives under `__tests__/` so the tenant-scope guard's seed/cleanup
 * exemption covers its raw INSERTs (same convention as
 * `engine/fleet/__tests__/discovery-integration-test-support.ts`).
 *
 * `seedSendTenant`/`cleanupSendProbeClients` live in the sibling
 * `queue-send-tenant-fixture.ts` (P13 max-lines split, see that file's own
 * doc) - re-exported here so every existing import path is unchanged.
 */

export {
  cleanupSendProbeClients,
  seedSendTenant,
  type SeededSendTenant,
  type SeedSendTenantOptions,
  type TestPool,
} from './queue-send-tenant-fixture.js';

export interface SeedClaimedJobOptions {
  clientId: string;
  instanceId: string;
  attempts?: number;
  maxAttempts?: number;
  leaseId?: string;
  /** `message_jobs.recipient_jid` - defaults to a random `@s.whatsapp.net` DM jid. */
  recipientJid?: string;
}

export interface SeedClaimedJobResult {
  id: string;
  createdAt: Date;
  leaseId: string;
  publicId: string;
  /** The row's real `recipient_jid` - threads into `resolveFailure`/`resolveAck` calls so a test never passes a placeholder jid that does not match the seeded row (P24 CRITICAL 1 fix round). */
  recipientJid: string;
}

/** Inserts one message_jobs row already in 'processing' (i.e. already claimed) plus its message_job_refs row, returns identifying fields. */
export async function seedClaimedJob(
  pool: TestPool,
  options: SeedClaimedJobOptions,
): Promise<SeedClaimedJobResult> {
  const leaseId = options.leaseId ?? randomUUID();
  const publicId = randomUUID();
  const recipientJid = options.recipientJid ?? `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;

  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at, lease_expires_at)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'processing', now(),
             now(), $5, $6, 'worker-1', $7, 1, now(), now() + interval '90 seconds')
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      recipientJid,
      JSON.stringify({ text: 'hello' }),
      options.attempts ?? 0,
      options.maxAttempts ?? 5,
      leaseId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedClaimedJob: no row returned');

  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );

  return { id: row.id, createdAt: row.created_at, leaseId, publicId, recipientJid };
}

export interface SeedQueuedJobOptions {
  clientId: string;
  instanceId: string;
  /** `message_jobs.priority_rank` - defaults to 3, `DEFAULT_BAND_WEIGHTS.NORMAL` (`@wp/domain`'s DWRR weight table, the SAME numeric value `send-loop.ts`'s band selection claims against) - NOT `seedClaimedJob`'s own `10` (that helper predates `send-loop.ts` and is never claimed against by band). */
  priorityRank?: number;
  /** `message_jobs.is_new_conversation` - defaults `false`. Overridable so callers can seed the job's own stored cold-outreach classification the claim's RETURNING list surfaces (P13 correctness fix). */
  isNewConversation?: boolean;
  /** `message_jobs.recipient_jid` - defaults to a random `@s.whatsapp.net` DM JID. Pass a `@g.us` JID to seed a group send. */
  recipientJid?: string;
}

export interface SeedQueuedJobResult {
  id: string;
  createdAt: Date;
  publicId: string;
}

/** Inserts one message_jobs row in 'queued' (NOT yet claimed) plus its message_job_refs row - the wake-loop integration suite's own seed shape (`wake.integration.test.ts`), distinct from `seedClaimedJob` (which starts already 'processing'). */
export async function seedQueuedJob(
  pool: TestPool,
  options: SeedQueuedJobOptions,
): Promise<SeedQueuedJobResult> {
  const publicId = randomUUID();

  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', $5, 'queued', now(), now(), 0, 5, $6)
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      options.recipientJid ?? `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
      JSON.stringify({ text: 'hello' }),
      options.priorityRank ?? 3,
      options.isNewConversation ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedQueuedJob: no row returned');

  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );

  return { id: row.id, createdAt: row.created_at, publicId };
}

export interface JobResultRow {
  status: string;
  attempts: number;
  sent_at: Date | null;
  failed_at: Date | null;
  terminal_at: Date | null;
  last_error_class: string | null;
  next_attempt_at: Date;
  cancel_reason: string | null;
}

export async function getJobResultRow(pool: TestPool, id: string): Promise<JobResultRow> {
  const result = await pool.query<JobResultRow>(
    `SELECT status, attempts, sent_at, failed_at, terminal_at, last_error_class,
            next_attempt_at, cancel_reason
       FROM message_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`getJobResultRow: no message_jobs row with id ${id}`);
  return row;
}

export interface SeededDispatchedAttempt {
  clientId: string;
  instanceId: string;
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  publicId: string;
  attemptNo: number;
  /** The seeded row's real `recipient_jid` - see `SeedClaimedJobResult.recipientJid`'s own doc. */
  recipientJid: string;
}

/**
 * Seeds a claimed job (already 'processing') PLUS its `send_attempts` row
 * already in `state='dispatched'` - the exact state `result.ts`'s two
 * entry points (`resolveAck`/`resolveFailure`) expect to find, so a
 * result-write test can start from "the send just settled" without
 * re-running `dispatch.ts` itself (that half is proved by
 * `dispatch.integration.test.ts`). Shared by `result.integration.test.ts`
 * and `result-failure.integration.test.ts` (split at the max-lines cap).
 */
export async function seedDispatchedAttempt(
  pool: TestPool,
  probeClientIds: string[],
  options: { attempts?: number; maxAttempts?: number } = {},
): Promise<SeededDispatchedAttempt> {
  const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
  const job = await seedClaimedJob(pool, {
    clientId,
    instanceId,
    attempts: options.attempts ?? 0,
    maxAttempts: options.maxAttempts ?? 5,
  });
  const attemptNo = (options.attempts ?? 0) + 1;
  // `message_job_created_at` is bound from `message_jobs.created_at` INSIDE
  // this same statement (a scalar subquery), never from the already-
  // round-tripped `job.createdAt` JS `Date` - the pg driver truncates a
  // `timestamptz`'s microsecond precision to JS `Date`'s millisecond
  // precision, so re-binding `job.createdAt` here would silently produce a
  // `message_job_created_at` that no longer equality-matches `message_jobs.
  // created_at`, and every exact-equality JOIN on that pair (e.g. migration
  // 0053's `wp_wallet_check_missing_debits`) would match zero rows against
  // the very row that produced it - same bug class as `messages.repo.ts`'s
  // documented `job` CTE fix, applied here the same way.
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at)
     SELECT $1, $2, $3, j.created_at, $4, $5, 'dispatched', now(), now()
       FROM message_jobs j WHERE j.id = $3`,
    [clientId, instanceId, job.id, job.leaseId, attemptNo],
  );
  return {
    clientId,
    instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    leaseId: job.leaseId,
    publicId: job.publicId,
    attemptNo,
    recipientJid: job.recipientJid,
  };
}

/**
 * Re-claims `jobId` through the REAL `claimOne()` (the only statement
 * allowed to perform the `queued -> processing` transition -
 * `db/queries/claim-jobs.sql`, enforced by `scripts/check-single-claim.ts`)
 * instead of a shortcut UPDATE. First clears the backoff wait via a
 * `next_attempt_at`-only UPDATE (never touching `status` - adjusting a
 * schedule is not claiming), then runs `claimOne` inside `withTenant` (a
 * raw pool sees zero rows under RLS). Returns the FRESH `lease_id`
 * `claim-jobs.sql` mints on every claim - callers MUST thread this into the
 * next `dispatch()`/`resolveFailure()` call, never the original job's lease
 * id, or every subsequent job-outcome write matches zero rows
 * (`ClaimLostDuringSend`/`ClaimLostBeforeDispatch`). Used by
 * `result-retry-budget.integration.test.ts` to drive a real retry loop
 * instead of hand-forcing `status='processing'`.
 */
export async function reclaimRequeuedJob(
  pool: TestPool,
  tenantDb: ReturnType<typeof createTenantDb>,
  params: { clientId: string; instanceId: string; jobId: string; fence: number },
): Promise<string> {
  await pool.query(
    'UPDATE message_jobs SET next_attempt_at = now() WHERE id = $1 AND client_id = $2',
    [params.jobId, params.clientId],
  );

  const claimed = await tenantDb.withTenant(params.clientId, (tx) =>
    claimOne(
      { clientId: params.clientId, sql: tx },
      {
        instanceId: params.instanceId,
        band: 10,
        fence: params.fence,
        workerId: 'result-retry-budget-test-worker',
        claimExpiryMs: 90_000,
      },
    ),
  );

  if (!claimed) {
    throw new Error(
      `reclaimRequeuedJob: claimOne() returned undefined for job ${params.jobId} - the job was not eligible for re-claim (check fence/health/epoch/wallet/campaign predicates in claim-jobs.sql)`,
    );
  }

  return claimed.leaseId;
}

/**
 * Opens its own short-lived Redis connection and deletes each probe
 * client's wallet-charger list (`tenantKey(env, clientId, 'charge')`) plus
 * its pending-index membership (`sysKey(env, 'sys', 'wallet',
 * 'charge-pending')`) - P18 gate close (2026-09-04) `afterEach` hygiene
 * shared by every charger-driving integration test, so a mid-test failure
 * never leaks a key into the shared dev Redis for
 * `isolation-suite-c.integration.test.ts` to flag. Never `FLUSHALL` - only
 * the caller's own probe clients' keys.
 */
export async function cleanupChargerRedisKeys(
  env: string,
  probeClientIds: string[],
): Promise<void> {
  if (probeClientIds.length === 0) return;
  const redis = createRedis(resolveRedisUrl());
  try {
    const pendingKey = sysKey(env, 'sys', 'wallet', 'charge-pending');
    for (const clientId of probeClientIds) {
      await redis.del(tenantKey(env, clientId, 'charge'));
      await redis.srem(pendingKey, clientId);
    }
  } finally {
    redis.disconnect();
  }
}
