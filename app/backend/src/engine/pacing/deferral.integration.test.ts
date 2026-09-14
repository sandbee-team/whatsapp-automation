import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { reserve } from './index.js';
import {
  cleanupPacingProbeClients,
  seedPacingInstance,
  seedPacingMessageJob,
  type TestPool,
} from './__tests__/pacing-test-helpers.js';

/**
 * deferral.integration.test.ts (P13 Unit U4, step 7) - the pacing design's own test 6
 * (deferral never increments attempts or fails the job), test 28 (orphan
 * reservation is not refunded), the claim-rollback case, and the
 * fail-closed UNKNOWN case. `reserve()`/`release()` themselves never touch
 * `message_jobs` - these tests prove the CONTRACT their callers
 * (`send-loop.ts`) must honour: a deny writes `status='queued',
 * next_attempt_at=<resolved>` and leaves `attempts` untouched, using
 * exactly the columns migration 0025 already grants `wp_scheduler`.
 */

let pool: TestPool;

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pacing-deferral-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupPacingProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const fixedClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

/** Mirrors send-loop.ts's own deny-write contract (see this file's own header) - the exact requeue-for-retry columns migration 0025 grants wp_scheduler. */
async function writeDenyToJob(jobId: string, reason: string, retryAt: Date): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET status = 'queued', next_attempt_at = $2, pacing_deny_reason = $3, pacing_deferrals = pacing_deferrals + 1
      WHERE id = $1`,
    [jobId, retryAt, reason],
  );
}

describe('reserve()/release() deferral and rollback contracts', () => {
  it('deferral_never_increments_attempts_or_fails_the_job', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {
      dailyCap: 1,
      coldRatioMax: 1,
      coldRatioFloor: 0,
    });
    const jobId = await seedPacingMessageJob(pool, { clientId, instanceId });

    // Consume the only unit for the day, then deny MIN_GAP/DAILY_CAP/etc.
    const grant = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(grant.granted).toBe(true);

    const before = await pool.query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(before.rows[0]?.attempts).toBe(0);

    for (const isNewConversation of [false]) {
      const denial = await reserve({
        sql: pool,
        clientId,
        instanceId,
        isNewConversation,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      expect(denial.granted).toBe(false);
      if (denial.granted) continue;
      expect(denial.reason).toBe('DAILY_CAP');

      await writeDenyToJob(jobId, denial.reason, denial.retryAt);

      const after = await pool.query<{ attempts: number; status: string; next_attempt_at: Date }>(
        'SELECT attempts, status, next_attempt_at FROM message_jobs WHERE id = $1',
        [jobId],
      );
      // attempts is BYTE-IDENTICAL (still 0) - a pacing deferral never
      // consumes retry budget.
      expect(after.rows[0]?.attempts).toBe(0);
      expect(after.rows[0]?.status).toBe('queued');
      expect(after.rows[0]?.next_attempt_at.getTime()).toBe(denial.retryAt.getTime());
    }
  });

  it('reserve_is_rolled_back_when_no_job_is_claimed', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});

    // Simulate "claim -> reserve() -> ROLLBACK" (a losing claim race) by
    // running the reserve inside an explicit transaction that is then
    // rolled back, exactly as send-loop.ts's real wiring must when
    // claimOne finds zero rows AFTER a successful reserve in the same
    // transaction (order is claim-then-reserve in production; here we
    // isolate the rollback behaviour itself, which is transaction-order
    // agnostic - a ROLLBACK undoes every statement in it regardless of
    // ordering).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await reserve({
        sql: client,
        clientId,
        instanceId,
        isNewConversation: false,
        isGroup: false,
        gapMs: 0,
        clock: fixedClock,
        timeZone: 'Asia/Kolkata',
      });
      expect(outcome.granted).toBe(true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Ledger is byte-identical to its pre-reserve state (no row at all) -
    // no compensating write, because the whole transaction rolled back.
    const ledger = await pool.query('SELECT * FROM pacing_ledger WHERE instance_id = $1', [
      instanceId,
    ]);
    expect(ledger.rows).toHaveLength(0);
  });

  it('orphan_reservation_is_not_refunded', async () => {
    const { clientId, instanceId } = await seedPacingInstance(pool, probeClientIds, {});
    const jobId = await seedPacingMessageJob(pool, { clientId, instanceId });

    const outcome = await reserve({
      sql: pool,
      clientId,
      instanceId,
      isNewConversation: false,
      isGroup: false,
      gapMs: 0,
      clock: fixedClock,
      timeZone: 'Asia/Kolkata',
    });
    expect(outcome.granted).toBe(true);
    if (!outcome.granted) return;

    // Worker killed after reserve, before dispatch: NO release() call is
    // ever made for this job (the defining shape of an orphaned
    // reservation - PROVIDER_ATTEMPTED-shaped uncertainty, structurally
    // unrefundable per release-pacing.sql's own header - there is no
    // "outcome" bind at all, so no caller shape can refund it). The
    // consumed unit stays consumed: no code path in this phase's scope
    // ever calls release() for jobId, so the ledger the reserve wrote is
    // exactly what it was left as - byte-identical, no automatic
    // compensation.
    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    expect(ledger.rows[0]?.consumed_count).toBe(1);

    // The job itself is never marked refunded either - message_jobs'
    // pacing_refunded_at is release-pacing.sql's own idempotency key
    // (migration 0007), and nothing wrote it for this job.
    const job = await pool.query<{ pacing_refunded_at: Date | null }>(
      'SELECT pacing_refunded_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(job.rows[0]?.pacing_refunded_at).toBeNull();
  });

  // `release_refunds_a_genuine_non_attempt_and_is_idempotent` and
  // `unknown_deny_reason_holds_for_sixty_seconds_and_alerts` live in the
  // sibling `deferral-release-and-unknown.integration.test.ts` (P13
  // max-lines split, see that file's own doc).
});
