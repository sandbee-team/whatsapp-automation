import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { claimAndReserve } from '../../../engine/queue/send-loop-pacing-claim.js';
import {
  cleanupSendProbeClients,
  seedSendTenant,
  type TestPool,
} from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import { recordOptOut, type OptOutMirrorPort } from '../optout/registry.js';

/** No contacts seeded in this suite - the P20 mirror port is proved for real in optout-mirror.integration.test.ts. */
const noopMirror: OptOutMirrorPort = async () => ({ contactsUpdated: 0 });

/**
 * pipeline.integration.test.ts (P14 Unit U6, phase step 7) - the guard
 * pipeline wired all the way through `claimAndReserve()`, against real
 * Postgres. Mandatory test 6 (extended): deferral never touches
 * attempts/fails the job. Plus: a terminal guard never consumes a pacing
 * unit. The other two of the phase file's four named cases (the
 * 25-disposals-per-pass cap, and "no observer ever sees a deferred job in
 * 'processing'") live in the sibling
 * `pipeline-disposal-loop.integration.test.ts` (this file's own max-lines
 * cap - same established split idiom as `session-worker-discovery-
 * wiring.ts`).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'guard-pipeline-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await pool.query('DELETE FROM opt_outs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM content_fingerprint_recipients WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM content_fingerprints WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    // P17 U6 (step 5) - the NEEDS_HUMAN_ACK trip now also calls notify().
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
  }
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

const claimClock = { now: () => Date.UTC(2026, 8, 2, 12, 0, 0) };

function makeClaimAndReserve(onGuardTrip?: (reason: string) => void) {
  const tenantDb = createTenantDb(pool);
  return claimAndReserve({ tenantDb, rng: { random: () => 0.5 }, clock: claimClock, onGuardTrip });
}

interface SeedGuardJobOptions {
  clientId: string;
  instanceId: string;
  recipientHash?: Buffer | null;
  recipientJid?: string;
  body?: string;
  priorityRank?: number;
}

/** Seeds one queued message_jobs row with a caller-chosen `recipient_hash`/body - `queue-send-test-helpers.ts#seedQueuedJob` has neither knob, so the guard suite needs its own local seed. */
async function seedGuardJob(pool: TestPool, options: SeedGuardJobOptions): Promise<{ id: string }> {
  const publicId = randomUUID();
  const recipientJid = options.recipientJid ?? `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`;
  const result = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO message_jobs
       (client_id, instance_id, session_epoch, recipient_jid, recipient_e164, recipient_hash,
        payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at,
        attempts, max_attempts, is_new_conversation)
     VALUES ($1, $2, 0, $3, '+15550000000', $4, $5, 'text', 'normal', $6, 'queued', now(), now(), 0, 5, false)
     RETURNING id, created_at`,
    [
      options.clientId,
      options.instanceId,
      recipientJid,
      options.recipientHash ?? null,
      JSON.stringify({ text: options.body ?? 'Thanks for your order, see you soon!' }),
      options.priorityRank ?? 3,
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

async function jobRow(id: string) {
  const result = await pool.query<{
    status: string;
    attempts: number;
    pacing_deferrals: number;
    pacing_deny_reason: string | null;
    next_attempt_at: Date;
    lease_id: string | null;
    cancel_reason: string | null;
    last_error_class: string | null;
  }>(
    `SELECT status, attempts, pacing_deferrals, pacing_deny_reason, next_attempt_at, lease_id,
            cancel_reason, last_error_class
       FROM message_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`jobRow: no message_jobs row with id ${id}`);
  return row;
}

describe('evaluateGuards wired through claimAndReserve (P14 Unit U6, real Postgres)', () => {
  it('deferral_never_increments_attempts_or_fails_the_job', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('pipeline-freq-defer-hash');

    // PER_RECIPIENT_FREQ: safe_default's per_recipient_24h = 3 (migration
    // 0040 seed correction) - three prior buckets already at the limit.
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO recipient_send_buckets (client_id, phone_hash, hour_bucket, count)
         VALUES ($1, $2, $3, 1)`,
        [clientId, phoneHash, new Date(claimClock.now() - (i + 1) * 60 * 60 * 1000)],
      );
    }
    const freqJob = await seedGuardJob(pool, { clientId, instanceId, recipientHash: phoneHash });

    const claimAndReserveFn = makeClaimAndReserve();
    const claimed = await claimAndReserveFn(
      { clientId, sql: pool },
      {
        instanceId,
        band: 3,
        fence: 1,
        workerId: 'guard-pipeline-test-worker',
        claimExpiryMs: 90_000,
      },
    );
    expect(claimed).toBeUndefined();

    const freqRow = await jobRow(freqJob.id);
    expect(freqRow.status).toBe('queued');
    expect(freqRow.attempts).toBe(0);
    expect(freqRow.pacing_deferrals).toBe(1);
    expect(freqRow.pacing_deny_reason).toBe('PER_RECIPIENT_FREQ');
    expect(freqRow.lease_id).toBeNull();

    // NEEDS_HUMAN_ACK: safe_default's dup_fanout_ack = 60 - drive the same
    // fingerprint past it with 61 distinct recipients, then claim the 61st
    // job (the one that trips the guard). Each claim is driven one job at a
    // time (rather than draining a shared band): the guard pipeline runs
    // BEFORE the pacing reserve in claimAndReserve's own ordering, so the
    // fingerprint's recipient_count increments on every evaluation
    // regardless of whether the SAME attempt then also pacing-denies on
    // MIN_GAP (the fixture's 15s gap floor, real wall-clock time, is far
    // longer than this loop's own real elapsed time) - the guard trip is
    // proven directly off each job's own row, never off claimAndReserve's
    // return value (which would conflate a guard trip with an ordinary
    // pacing defer).
    const body = 'Guard pipeline dedupe fixture body, exact match every time';
    const ackJobs: string[] = [];
    for (let i = 0; i < 61; i += 1) {
      const job = await seedGuardJob(pool, {
        clientId,
        instanceId,
        recipientHash: Buffer.from(`ack-recipient-${String(i).padStart(4, '0')}`),
        body,
        priorityRank: 6,
      });
      ackJobs.push(job.id);
    }

    // Every OTHER ack job is pushed a full day into the future first, so
    // `claim-jobs.sql`'s `ORDER BY next_attempt_at, id` can never tie-break
    // back onto an earlier job by `id` (real wall-clock `now()` has
    // microsecond resolution but this loop's own iterations can complete
    // faster than that resolution distinguishes, which silently reclaimed
    // job 0 on every iteration in an earlier version of this test).
    await pool.query(
      `UPDATE message_jobs SET next_attempt_at = now() + interval '1 day' WHERE id = ANY($1)`,
      [ackJobs],
    );

    const drainer = makeClaimAndReserve();
    for (const jobId of ackJobs) {
      await pool.query('UPDATE message_jobs SET next_attempt_at = now() WHERE id = $1', [jobId]);
      await drainer(
        { clientId, sql: pool },
        {
          instanceId,
          band: 6,
          fence: 1,
          workerId: 'guard-pipeline-test-worker',
          claimExpiryMs: 90_000,
        },
      );
    }

    const ackedRow = await jobRow(ackJobs[60]!);
    expect(ackedRow.status).toBe('queued');
    expect(ackedRow.attempts).toBe(0);
    expect(ackedRow.pacing_deny_reason).toBe('NEEDS_HUMAN_ACK');
    expect(ackedRow.next_attempt_at.getTime()).toBe(claimClock.now() + 300_000);
    expect(ackedRow.lease_id).toBeNull();

    // P17 U6 (step 5) - exactly ONE `duplicate_fanout_ack_required`
    // notification for this fingerprint+day, even though only the 61st claim
    // (the one that first crosses dup_fanout_ack=60) trips the guard.
    const notificationRows = await pool.query<{ kind: string; requires_user_action: boolean }>(
      `SELECT kind, requires_user_action FROM notifications WHERE client_id = $1`,
      [clientId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('duplicate_fanout_ack_required');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(true);
  });

  it('a_terminal_guard_never_consumes_a_pacing_unit', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const phoneHash = Buffer.from('pipeline-terminal-no-unit-hash');
    const tenantDb = createTenantDb(pool);
    await tenantDb.withTenant(clientId, (tx) =>
      recordOptOut(
        tx,
        {
          clientId,
          scope: 'client',
          scopeKey: clientId,
          phoneHash,
          phoneEnc: Buffer.from('fixture-ciphertext'),
          source: 'manual',
        },
        { mirror: noopMirror },
      ),
    );

    const claimAndReserveFn = makeClaimAndReserve();
    for (let i = 0; i < 100; i += 1) {
      const kind = i % 2 === 0 ? 'optedOut' : 'blockedWord';
      await seedGuardJob(pool, {
        clientId,
        instanceId,
        recipientHash: kind === 'optedOut' ? phoneHash : Buffer.from(`bw-${String(i)}`),
        body: kind === 'blockedWord' ? 'Please send me the OTP right now' : undefined,
      });
    }

    for (let i = 0; i < 100; i += 1) {
      // Draining one at a time (band width small enough that the
      // MAX_DISPOSALS_PER_PASS cap is never hit) proves every one of the
      // 100 seeded jobs disposes, not just the first batch.
      await claimAndReserveFn(
        { clientId, sql: pool },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'guard-pipeline-test-worker',
          claimExpiryMs: 90_000,
        },
      );
    }

    const ledger = await pool.query<{ consumed_count: number }>(
      'SELECT consumed_count FROM pacing_ledger WHERE instance_id = $1',
      [instanceId],
    );
    // No ledger row at all is the byte-identical "never touched" proof -
    // reserve() was never called for any of the 100 disposed jobs.
    expect(ledger.rows).toEqual([]);
  });

  // 'a_terminal_guard_disposes_up_to_twenty_five_jobs_in_one_pass' and
  // 'no_observer_ever_sees_a_deferred_job_in_processing' moved to the
  // sibling 'pipeline-disposal-loop.integration.test.ts' - this file's own
  // max-lines cap (same established split idiom as
  // 'session-worker-discovery-wiring.ts').
});
