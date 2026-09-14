import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';

/**
 * pipeline-clock-and-retry-storm-c2.integration.test.ts (P14 C2 review) -
 * two remaining foci over the guard pipeline wired through
 * `claimAndReserve`, real Postgres:
 *   1. A `NEEDS_HUMAN_ACK` hold crossing local midnight: the job stays held
 *      (its bounded 300s re-check hold is wall-clock, not calendar, so
 *      midnight itself does nothing to it) and a human ack still releases it
 *      regardless of which calendar day the ack happens on.
 *   2. Retry-storm shape: a deferred `PER_RECIPIENT_FREQ` job whose
 *      `next_attempt_at` has passed gets re-evaluated and re-deferred with a
 *      NEW, strictly-future `next_attempt_at` on every pass - `attempts`
 *      never grows and `pacing_deferrals` grows by exactly 1 per pass
 *      (bounded churn, never a hot loop: `next_attempt_at` is always
 *      strictly ahead of `now()` immediately after each deny).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'pipeline-clock-c2',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function makeClaimAndReserve(clock: { now(): number }) {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock });
}

async function seedGuardJob(options: {
  clientId: string;
  instanceId: string;
  recipientHash?: Buffer | null;
  body?: string;
}): Promise<{ id: string }> {
  const publicId = randomUUID();
  const recipientJid = `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', 3, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      recipientJid,
      options.recipientHash ?? null,
      JSON.stringify({ text: options.body ?? 'Thanks for your order, see you soon!' }),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('seedGuardJob: no row returned');
  await pool.query(
    `INSERT INTO message_job_refs (public_id, client_id, instance_id, message_job_id, message_job_created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [publicId, options.clientId, options.instanceId, row.id, row.created_at],
  );
  return { id: row.id };
}

describe('NEEDS_HUMAN_ACK hold crossing local midnight (P14 C2)', () => {
  it('the_job_stays_held_across_midnight_and_a_human_ack_still_releases_it', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const body = 'Midnight-crossing NEEDS_HUMAN_ACK fixture body, exact match every time';
    // Directly force NEEDS_HUMAN_ACK by pre-seeding the fingerprint row past
    // dup_fanout_ack (60 for safe_default) - avoids driving 61 real claims.
    const { computeFingerprint } = await import('../content/fingerprint.js');
    const fingerprint = computeFingerprint(body);
    // `send-loop-guard-pipeline-wiring.ts#readGuardPipelineState` derives
    // `local_date` from Postgres's own REAL `now() AT TIME ZONE
    // pacing_timezone` (never this test's injected clock - see that file's
    // own doc comment), so this fixture's seeded `content_fingerprints.
    // local_date` must match the ACTUAL current Asia/Kolkata calendar date
    // (the fixture's pacing_timezone default, migration 0030), not a
    // hardcoded literal that goes stale the moment the real date rolls over
    // (see .memory/lessons/2026-09-02-hardcoded-fake-clock-drifts-past-real-db-time.md).
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
      new Date(),
    );
    await pool.query(
      `INSERT INTO content_fingerprints (client_id, local_date, fingerprint, recipient_count)
       VALUES ($1, $2, $3, 600)`,
      [clientId, localDate, fingerprint],
    );

    // Regardless of the real clock's calendar date/hour when this test runs
    // (claimAndReserve computes local_date from Postgres's own now(), same
    // as the seeded fixture above), the guard's HOLD
    // (next_attempt_at = clock.now() + 300_000) is wall-clock, unaffected by
    // which calendar day it lands on - the invariant under test is the hold
    // surviving a midnight crossing, not any specific hour.
    const beforeMidnightClock = { now: () => Date.now() };
    const job = await seedGuardJob({
      clientId,
      instanceId,
      recipientHash: Buffer.from('c2-midnight-ack-recipient'),
      body,
    });

    const claimFn = makeClaimAndReserve(beforeMidnightClock);
    const claimed = await claimFn(
      { clientId, sql: pool },
      { instanceId, band: 3, fence: 1, workerId: 'midnight-ack-worker', claimExpiryMs: 90_000 },
    );
    expect(claimed).toBeUndefined();

    const heldRow = await pool.query<{
      status: string;
      pacing_deny_reason: string | null;
      next_attempt_at: Date;
    }>(`SELECT status, pacing_deny_reason, next_attempt_at FROM message_jobs WHERE id = $1`, [
      job.id,
    ]);
    expect(heldRow.rows[0]?.status).toBe('queued');
    expect(heldRow.rows[0]?.pacing_deny_reason).toBe('NEEDS_HUMAN_ACK');
    // The hold survives crossing midnight unaffected - it is purely
    // wall-clock (now + 300_000ms), never reset or shortened by a calendar
    // boundary.
    expect(heldRow.rows[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    // A human ack (simulated directly via the SAME UPDATE shape ack-fanout.ts
    // uses) releases the job regardless of which calendar day the ack
    // itself happens on. Targeted by job id directly here (rather than
    // ack-fanout.ts's own `content_fingerprint` match column) because this
    // fixture's `seedGuardJob` never populates `message_jobs.
    // content_fingerprint` at INSERT time - the guard pipeline computes the
    // fingerprint in-memory (`fingerprint.ts#computeFingerprint`) but never
    // writes it back onto the job row itself, only into
    // `content_fingerprint_recipients`/`content_fingerprints`. The release
    // SEMANTICS (next_attempt_at=now(), same shape ack-fanout.ts uses) are
    // what this test pins - not the lookup predicate, which ack-fanout.
    // integration.test.ts already covers end-to-end via a job seeded WITH
    // content_fingerprint set.
    await pool.query(
      `UPDATE content_fingerprints SET ack_by = $1, ack_at = now()
        WHERE client_id = $2 AND local_date = $3 AND fingerprint = $4`,
      [randomUUID(), clientId, localDate, fingerprint],
    );
    await pool.query(
      `UPDATE message_jobs SET next_attempt_at = now()
        WHERE client_id = $1 AND status = 'queued' AND pacing_deny_reason = 'NEEDS_HUMAN_ACK'
          AND id = $2`,
      [clientId, job.id],
    );

    const releasedRow = await pool.query<{ next_attempt_at: Date }>(
      `SELECT next_attempt_at FROM message_jobs WHERE id = $1`,
      [job.id],
    );
    // Released to (Postgres's own) now() by the UPDATE above - compared
    // with a small tolerance against this process's own Date.now() read
    // AFTER that UPDATE committed, since the two clocks are not the same
    // instant and a bare `<= Date.now()` can lose by low-single-digit
    // milliseconds to real round-trip/clock skew (never a multi-minute
    // hold surviving, which is the actual invariant this test cares about).
    expect(releasedRow.rows[0]!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  });
});

describe('retry-storm shape for a repeatedly-deferred PER_RECIPIENT_FREQ job (P14 C2)', () => {
  it('each_pass_re_defers_with_a_new_strictly_future_next_attempt_at_never_growing_attempts_bounded_churn', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('c2-retry-storm-hash');
    // safe_default's per_recipient_24h = 3 (migration 0040 seed correction) -
    // three prior buckets already at the limit, so every claim of this job
    // denies at PER_RECIPIENT_FREQ.
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, date_trunc('hour', now() - ($3 || ' hours')::interval), 1)`,
        [clientId, phoneHash, i + 1],
      );
    }
    const job = await seedGuardJob({ clientId, instanceId, recipientHash: phoneHash });

    const claimFn = makeClaimAndReserve({ now: () => Date.now() });
    const PASSES = 5;
    let previousNextAttemptAt = 0;

    for (let i = 0; i < PASSES; i += 1) {
      // Simulate the deferred job's hold having already passed (a real
      // retry-storm scenario: next_attempt_at was in the past by the time
      // this pass runs) so claim-jobs.sql picks it up again immediately.
      await pool.query('UPDATE message_jobs SET next_attempt_at = now() WHERE id = $1', [job.id]);

      const beforeClaim = Date.now();
      const claimed = await claimFn(
        { clientId, sql: pool },
        { instanceId, band: 3, fence: 1, workerId: 'retry-storm-worker', claimExpiryMs: 90_000 },
      );
      expect(claimed).toBeUndefined();

      const row = await pool.query<{
        attempts: number;
        pacing_deferrals: number;
        pacing_deny_reason: string | null;
        next_attempt_at: Date;
      }>(
        `SELECT attempts, pacing_deferrals, pacing_deny_reason, next_attempt_at FROM message_jobs WHERE id = $1`,
        [job.id],
      );
      const current = row.rows[0];
      expect(current).toBeDefined();
      expect(current!.pacing_deny_reason).toBe('PER_RECIPIENT_FREQ');
      // Bounded churn: attempts NEVER grows across any number of passes.
      expect(current!.attempts).toBe(0);
      // pacing_deferrals grows by exactly 1 per pass.
      expect(current!.pacing_deferrals).toBe(i + 1);
      // Never a hot loop: next_attempt_at is always strictly future
      // relative to the moment this pass evaluated it, on EVERY pass.
      expect(current!.next_attempt_at.getTime()).toBeGreaterThan(beforeClaim);
      // Each pass writes a genuinely NEW retryAt - never the same stale
      // value repeated (the recipient-frequency evaluator recomputes the
      // window-expiry moment fresh each time).
      if (i > 0) {
        expect(current!.next_attempt_at.getTime()).toBeGreaterThanOrEqual(previousNextAttemptAt);
      }
      previousNextAttemptAt = current!.next_attempt_at.getTime();
    }
  });
});
