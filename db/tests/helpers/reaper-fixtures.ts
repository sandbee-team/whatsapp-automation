import { randomUUID } from 'node:crypto';
import { getMigratedPool } from './migrated-db.js';

/**
 * db/tests/helpers/reaper-fixtures.ts (P12 U2a) - split out of
 * `reaper-definer.test.ts` (max-lines cap) once the file grew a second
 * behavioral test file (`reaper-repair-contract.test.ts`) that needs the
 * SAME seed helpers. No test assertions live here - pure fixture/insert
 * helpers only, following `reconcile-support-schema.test.ts`'s
 * `insertMessageJob` idiom.
 *
 * `jobCreatedAt`/`message_job_created_at` are deliberately NEVER accepted as
 * a parameter and re-bound anywhere in this file - see .memory/lessons/
 * 2026-09-01-timestamptz-microseconds-vs-js-date-milliseconds.md: a
 * timestamptz round-tripped through a JS Date loses microsecond precision
 * (and, separately, re-binding it as a `pg` parameter was observed to desync
 * the wire protocol entirely - "insufficient data left in message" - not
 * just silently mismatch). Every helper below resolves
 * `message_job_created_at` server-side via a subquery on the globally-unique
 * `id` instead.
 */

export interface PgError extends Error {
  code?: string;
}

export interface ReapedRow {
  client_id: string;
  instance_id: string;
  message_job_id: string;
  message_job_created_at: Date;
  new_status: string;
  attempt_state: string | null;
  send_attempt_id: string | null;
  send_attempt_no: number | null;
}

export async function insertProcessingJob(params: {
  clientId: string;
  instanceId: string;
  leaseId?: string;
  leaseExpiresAtSql: string; // raw SQL expression, e.g. "now() - interval '1 minute'"
  status?: string;
  /** Defaults to 1 (this helper's original hardcoded value) - additive param (P12 C1 review, migration 0029 finding 1 follow-up) so a caller can seed the exact `attempts` value an exhaustion test needs. */
  attempts?: number;
  /** Defaults to `message_jobs`' own column default (5) when omitted. */
  maxAttempts?: number;
}): Promise<{ id: string; createdAt: Date }> {
  const pool = await getMigratedPool();
  const leaseId = params.leaseId ?? randomUUID();
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at,
        next_attempt_at, attempts, max_attempts, lease_owner, lease_id, owner_fence, leased_at,
        lease_expires_at)
     VALUES ($1, $2, 0, '15550000000@s.whatsapp.net', '+15550000000',
             '{"text":"probe"}', 'text', 'normal', 10, $4::job_status, now(), now(), $5,
             COALESCE($6, 5), 'worker-probe', $3, 1, now(), ${params.leaseExpiresAtSql})
     RETURNING id, created_at`,
    [
      params.clientId,
      params.instanceId,
      leaseId,
      params.status ?? 'processing',
      params.attempts ?? 1,
      params.maxAttempts ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProcessingJob: no row returned');
  return { id: row.id, createdAt: row.created_at };
}

export async function insertSendAttempt(params: {
  clientId: string;
  instanceId: string;
  jobId: string;
  leaseId: string;
  state: string;
  attemptNo?: number;
}): Promise<{ id: string }> {
  const pool = await getMigratedPool();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        owner_fence, attempt_no, state, prepared_at, dispatched_at, resolved_at)
     SELECT $1, $2, $3, j.created_at, $4, 1, $5, $6, now(), now(), now()
       FROM message_jobs j WHERE j.id = $3
     RETURNING id`,
    [
      params.clientId,
      params.instanceId,
      params.jobId,
      params.leaseId,
      params.attemptNo ?? 1,
      params.state,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertSendAttempt: no row returned');
  return { id: row.id };
}

export async function readJobStatus(jobId: string): Promise<{
  status: string;
  attempts: number;
  sent_at: Date | null;
  terminal_at: Date | null;
}> {
  const pool = await getMigratedPool();
  const result = await pool.query<{
    status: string;
    attempts: number;
    sent_at: Date | null;
    terminal_at: Date | null;
  }>('SELECT status, attempts, sent_at, terminal_at FROM message_jobs WHERE id = $1', [jobId]);
  const row = result.rows[0];
  if (!row) throw new Error('readJobStatus: no row found');
  return row;
}

export async function seedNeedsReconcile(clientId: string, instanceId: string): Promise<string> {
  const pool = await getMigratedPool();
  const leaseId = randomUUID();
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
        payload, payload_kind, priority, priority_rank, status, scheduled_at,
        next_attempt_at, unresolved_at)
     VALUES ($1, $2, 0, '15550000000@s.whatsapp.net', '+15550000000',
             '{"text":"probe"}', 'text', 'normal', 10, 'needs_reconcile', now(), now(), now())
     RETURNING id, created_at`,
    [clientId, instanceId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedNeedsReconcile: no row returned');
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        owner_fence, attempt_no, state, prepared_at, dispatched_at, content_hash)
     SELECT $1, $2, $3, j.created_at, $4, 1, 1, 'dispatched', now(), now(), '\\x00'::bytea
       FROM message_jobs j WHERE j.id = $3`,
    [clientId, instanceId, row.id, leaseId],
  );
  return row.id;
}

/** Shared afterEach cleanup for both reaper test files - deletes every seeded row for the given client ids. */
export async function cleanupReaperProbeClients(clientIds: string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const pool = await getMigratedPool();
  await pool.query('DELETE FROM send_attempts WHERE client_id = ANY($1)', [clientIds]);
  await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [clientIds]);
}
