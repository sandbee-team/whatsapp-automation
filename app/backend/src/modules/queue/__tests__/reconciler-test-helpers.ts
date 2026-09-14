import {
  seedClaimedJob,
  seedSendTenant,
  type SeededSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';

/**
 * reconciler-test-helpers.ts (P12 Unit U3) - seeds a `message_jobs` row
 * already in `status='needs_reconcile'` with its in-flight `send_attempts`
 * row (`state='dispatched'`), for `reconciler.integration.test.ts`. A
 * DISTINCT, sibling-named helper from `queue-send-test-helpers.ts`'s own
 * `seedDispatchedAttempt` (which hardcodes `state='dispatched'`/job
 * `status='processing'` and is owned by P12 U2, running in parallel) -
 * coordinated by NOT editing that function, per this unit's own dispatch
 * note. Reuses `seedSendTenant`/`seedClaimedJob` from that same module for
 * the client/instance/job scaffolding (no duplication of that part).
 */

export interface SeededNeedsReconcileJob extends SeededSendTenant {
  jobId: string;
  jobCreatedAt: Date;
  publicId: string;
  sendAttemptId: string;
  attemptNo: number;
}

export interface SeedNeedsReconcileJobOptions {
  /** Defaults to `now()`. */
  dispatchedAt?: Date;
  contentHash: Buffer;
  /** Seeds onto an EXISTING (client, instance) pair instead of a fresh one - used to put two in-flight attempts on the SAME instance for the ambiguity case, without post-hoc client_id/instance_id UPDATEs that would fight RLS/FK consistency. */
  existingTenant?: SeededSendTenant;
}

export async function seedNeedsReconcileJob(
  pool: TestPool,
  probeClientIds: string[],
  options: SeedNeedsReconcileJobOptions,
): Promise<SeededNeedsReconcileJob> {
  const { clientId, instanceId } =
    options.existingTenant ?? (await seedSendTenant(pool, probeClientIds));
  const job = await seedClaimedJob(pool, { clientId, instanceId });

  await pool.query(
    `UPDATE message_jobs SET status = 'needs_reconcile', unresolved_at = now(),
            lease_owner = NULL, lease_id = NULL, lease_expires_at = NULL
      WHERE id = $1 AND client_id = $2`,
    [job.id, clientId],
  );

  // `message_job_created_at` is looked up SERVER-SIDE via a subquery, never
  // bound from the JS `Date` this function received back from `seedClaimedJob`
  // - a `timestamptz` round-tripped through JS truncates microsecond
  // precision, so a later `=` predicate against the real column (exactly
  // what `wp_reconcile_scan_unresolved`'s join does) would silently match
  // zero rows. See `.memory/lessons/2026-09-01-timestamptz-microseconds-vs-
  // js-date-milliseconds.md`.
  const attemptResult = await pool.query<{ id: string }>(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, content_hash, state, prepared_at, dispatched_at)
     SELECT $1, $2, $3, j.created_at, $4, 1, $5, 'dispatched', now(), $6
       FROM message_jobs j WHERE j.id = $3 AND j.client_id = $1
     RETURNING id`,
    [
      clientId,
      instanceId,
      job.id,
      job.leaseId,
      options.contentHash,
      options.dispatchedAt ?? new Date(),
    ],
  );
  const sendAttemptId = attemptResult.rows[0]?.id;
  if (!sendAttemptId) throw new Error('seedNeedsReconcileJob: no send_attempts row returned');

  return {
    clientId,
    instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    publicId: job.publicId,
    sendAttemptId,
    attemptNo: 1,
  };
}

/** Inserts one unresolved (`message_id IS NULL`) echo evidence row - the shape `echo-capture.ts` itself would write. */
export async function seedUnresolvedEvidence(
  pool: TestPool,
  input: {
    clientId: string;
    instanceId: string;
    waMsgId: string;
    contentHash: Buffer;
    observedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO message_wa_ids (client_id, instance_id, direction, wa_msg_id, content_hash, observed_at)
     VALUES ($1, $2, 'out', $3, $4, $5)`,
    [
      input.clientId,
      input.instanceId,
      input.waMsgId,
      input.contentHash,
      input.observedAt ?? new Date(),
    ],
  );
}
