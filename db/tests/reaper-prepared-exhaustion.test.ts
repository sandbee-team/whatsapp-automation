import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeMigratedPool, getMigratedPool } from './helpers/migrated-db.js';
import {
  cleanupReaperProbeClients,
  insertProcessingJob,
  insertSendAttempt,
  readJobStatus,
  type ReapedRow,
} from './helpers/reaper-fixtures.js';

/**
 * db/tests/reaper-prepared-exhaustion.test.ts (P12 C1 review, CRITICAL
 * finding 1 FOLLOW-UP) - proves `wp_reap_expired_leases`'s exhausted-
 * `prepared` branch (migration 0029: `WHEN e.attempt_state = 'prepared' AND
 * j.attempts >= j.max_attempts THEN 'failed'`) at the SQL level, using the
 * SAME server-side-resolved `message_job_created_at` idiom every other test
 * in this file already uses (`insertProcessingJob`/`insertSendAttempt`
 * never accept a JS `Date` and re-bind it - see `helpers/reaper-fixtures
 * .ts`'s own header for the timestamptz-microseconds-vs-JS-Date-
 * milliseconds lesson this sidesteps entirely).
 *
 * This SQL-level proof exists ALONGSIDE, not instead of, the app-level
 * `dispatch()`-driven proof
 * (`app/backend/src/modules/queue/reaper-prepared-collision.integration
 * .test.ts`/`reaper-prepared-collision-loop.integration.test.ts`) - see
 * this migration's own report for why the app-level REPEATED-cycle test
 * could not be completed honestly: `dispatch.ts`'s `prepareAndIncrement`
 * writes `send_attempts.message_job_created_at` from the caller-supplied JS
 * `Date` (`input.jobCreatedAt`), which loses microsecond precision on
 * every call - a PRE-EXISTING bug (present since P11, unrelated to this
 * review's two findings, `dispatch.ts` is out of this review's scope) that
 * silently breaks the reaper's own `a.message_job_created_at = j.created_at`
 * join for any job whose `created_at` is not exactly millisecond-aligned
 * (i.e., almost every real job) from the SECOND dispatch() call onward.
 * Verified live (see this migration's own report for the reproduction):
 * `wp_reap_expired_leases` returns `attempt_state: null` for a `send_attempts`
 * row inserted with a millisecond-truncated `message_job_created_at`, even
 * though every other column (lease_id, message_job_id) matches - the reaper
 * silently falls back to the no-attempt-row branch instead of finding the
 * real attempt. This file's helpers never hit that bug (server-side
 * resolution), so it proves the SQL exhaustion logic in isolation from it.
 */
describe('reaper_prepared_exhaustion', () => {
  let probeClientIds: string[] = [];

  afterEach(async () => {
    await cleanupReaperProbeClients(probeClientIds);
    probeClientIds = [];
  });

  afterAll(async () => {
    await closeMigratedPool();
  });

  it('a_prepared_crash_under_budget_still_requeues_with_attempts_unchanged', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const leaseId = randomUUID();
    const job = await insertProcessingJob({
      clientId,
      instanceId,
      leaseId,
      leaseExpiresAtSql: "now() - interval '1 minute'",
      attempts: 2,
      maxAttempts: 3,
    });
    const attempt = await insertSendAttempt({
      clientId,
      instanceId,
      jobId: job.id,
      leaseId,
      state: 'prepared',
      attemptNo: 2,
    });

    const pool = await getMigratedPool();
    const client = await pool.connect();
    let rows: ReapedRow[];
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await client.query('COMMIT');
      rows = result.rows;
    } finally {
      client.release();
    }

    const row = rows.find((r) => r.message_job_id === job.id);
    expect(row).toMatchObject({
      new_status: 'queued',
      attempt_state: 'prepared',
      send_attempt_id: attempt.id,
      max_attempts: 3,
    });

    const after = await readJobStatus(job.id);
    // Migration 0029: attempts stays exactly as dispatch() left it (2) -
    // never decremented (finding 1's fix) and not yet exhausted (2 < 3).
    expect(after.attempts).toBe(2);
    expect(after.status).toBe('queued');
  });

  it('a_prepared_crash_at_the_attempt_budget_goes_terminal_never_queued_again', async () => {
    const clientId = randomUUID();
    const instanceId = randomUUID();
    probeClientIds.push(clientId);

    const leaseId = randomUUID();
    const job = await insertProcessingJob({
      clientId,
      instanceId,
      leaseId,
      leaseExpiresAtSql: "now() - interval '1 minute'",
      attempts: 3,
      maxAttempts: 3,
    });
    const attempt = await insertSendAttempt({
      clientId,
      instanceId,
      jobId: job.id,
      leaseId,
      state: 'prepared',
      attemptNo: 3,
    });

    const pool = await getMigratedPool();
    const client = await pool.connect();
    let rows: ReapedRow[];
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      const result = await client.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await client.query('COMMIT');
      rows = result.rows;
    } finally {
      client.release();
    }

    const row = rows.find((r) => r.message_job_id === job.id);
    // Migration 0029 follow-up fix: attempts(3) >= max_attempts(3) -> the
    // 'prepared' branch goes TERMINAL, never 'queued' - closing the
    // unbounded-reclaim path this migration's own repeated-cycle harness
    // found live (see this file's own header).
    expect(row).toMatchObject({
      new_status: 'failed',
      attempt_state: 'prepared',
      send_attempt_id: attempt.id,
    });

    const after = await pool.query<{
      status: string;
      attempts: number;
      failed_at: Date | null;
      terminal_at: Date | null;
      last_error_class: string | null;
      next_attempt_at: Date;
    }>(
      'SELECT status, attempts, failed_at, terminal_at, last_error_class, next_attempt_at FROM message_jobs WHERE id = $1',
      [job.id],
    );
    const finalRow = after.rows[0];
    if (!finalRow) throw new Error('job vanished');
    expect(finalRow.status).toBe('failed');
    expect(finalRow.attempts).toBe(3); // unchanged, never decremented
    expect(finalRow.failed_at).not.toBeNull();
    expect(finalRow.terminal_at).not.toBeNull();
    expect(finalRow.last_error_class).toBe('prepared_crash_exhausted');

    // A second sweep must never touch this job again - it is terminal, not
    // 'processing', so the definer function's own WHERE clause excludes it.
    const secondClient = await pool.connect();
    let secondRows: ReapedRow[];
    try {
      await secondClient.query('BEGIN');
      await secondClient.query('SET LOCAL ROLE wp_scheduler');
      const secondResult = await secondClient.query<ReapedRow>(
        'SELECT * FROM wp_reap_expired_leases($1, $2)',
        [30, 500],
      );
      await secondClient.query('COMMIT');
      secondRows = secondResult.rows;
    } finally {
      secondClient.release();
    }
    expect(secondRows.find((r) => r.message_job_id === job.id)).toBeUndefined();
  });
});
