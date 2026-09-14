import { createPool } from '@wp/db';
import { seedClaimedJob } from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import type { WalletMetricsHandles } from '../../../platform/metrics/wallet-metrics.js';

/**
 * reconcile-test-support.ts (P18 Unit U8b) - shared, non-test fixture
 * machinery for `reconcile.integration.test.ts` /
 * `reconcile-checks.integration.test.ts` (split at the max-lines cap, same
 * idiom as `result-failure.integration.test.ts`). Lives under `__tests__/`
 * so the tenant-scope guard's seed/cleanup exemption covers its raw
 * cross-tenant-shaped UPDATEs (same convention as
 * `engine/queue/__tests__/queue-send-test-helpers.ts`'s own header) and so
 * vitest's `include` glob never picks it up as its own suite (no `.test.ts`
 * suffix).
 */

export type TestPool = ReturnType<typeof createPool>;

export function makeRecordingMetrics(): {
  metrics: Pick<WalletMetricsHandles, 'setDrift' | 'setClientsEmpty' | 'incDebit'>;
  drifts: number[];
  debits: string[];
} {
  const drifts: number[] = [];
  const debits: string[] = [];
  return {
    metrics: {
      setDrift: (n: number) => drifts.push(n),
      setClientsEmpty: () => undefined,
      incDebit: (k: string) => debits.push(k),
    },
    drifts,
    debits,
  };
}

export interface DispatchedAttemptOnTenant {
  jobId: string;
  jobCreatedAt: Date;
  leaseId: string;
  publicId: string;
  attemptNo: number;
}

/**
 * Seeds a SECOND (or later) claimed job + dispatched `send_attempts` row on
 * an ALREADY-seeded tenant (`seedSendTenant`'s result) - the per-CLIENT daily
 * correction cap test needs two dispatched attempts on the SAME client, and
 * `seedDispatchedAttempt` always seeds its own fresh tenant via
 * `seedSendTenant`. Mirrors `seedDispatchedAttempt`'s own job+attempt seed
 * shape exactly, minus the tenant creation.
 */
export async function seedDispatchedAttemptOnTenant(
  pool: TestPool,
  tenant: { clientId: string; instanceId: string },
): Promise<DispatchedAttemptOnTenant> {
  const job = await seedClaimedJob(pool, {
    clientId: tenant.clientId,
    instanceId: tenant.instanceId,
    attempts: 0,
    maxAttempts: 5,
  });
  const attemptNo = 1;
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at)
     SELECT $1, $2, $3, j.created_at, $4, $5, 'dispatched', now(), now()
       FROM message_jobs j WHERE j.id = $3`,
    [tenant.clientId, tenant.instanceId, job.id, job.leaseId, attemptNo],
  );
  return {
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    leaseId: job.leaseId,
    publicId: job.publicId,
    attemptNo,
  };
}

/** Marks a seeded dispatched attempt (`seedDispatchedAttempt`'s own shape) settled + its job `needs_reconcile` - check B's "not repaired" branch. */
export async function markNonRepairedMissingDebit(
  pool: TestPool,
  seeded: { jobId: string; attemptNo: number },
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
    [seeded.jobId, seeded.attemptNo],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('markNonRepairedMissingDebit: no send_attempts row seeded');
  await pool.query(
    `UPDATE send_attempts SET state = 'acked', resolved_at = now() - interval '30 minutes' WHERE id = $1`,
    [id],
  );
  await pool.query(`UPDATE message_jobs SET status = 'needs_reconcile' WHERE id = $1`, [
    seeded.jobId,
  ]);
  return id;
}

/** Marks a seeded dispatched attempt settled + its job already 'sent' - check B's "repaired" branch. */
export async function markRepairedMissingDebit(
  pool: TestPool,
  seeded: { jobId: string; attemptNo: number },
): Promise<string> {
  const row = await pool.query<{ id: string }>(
    'SELECT id FROM send_attempts WHERE message_job_id = $1 AND attempt_no = $2',
    [seeded.jobId, seeded.attemptNo],
  );
  const id = row.rows[0]?.id;
  if (!id) throw new Error('markRepairedMissingDebit: no send_attempts row seeded');
  await pool.query(
    `UPDATE send_attempts SET state = 'acked', resolved_at = now() - interval '30 minutes' WHERE id = $1`,
    [id],
  );
  await pool.query(
    `UPDATE message_jobs SET status = 'sent', sent_at = now(), terminal_at = now() WHERE id = $1`,
    [seeded.jobId],
  );
  return id;
}
