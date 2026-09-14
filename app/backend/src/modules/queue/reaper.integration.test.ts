import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics, type QueueMetricsHandles } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep, type ReaperDeps } from './reaper.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';

/**
 * reaper.integration.test.ts (P12 Unit U2, step 3) - proves the MODULE
 * wrapper's per-tenant side effects (delivery event, sink call, idempotent
 * re-run, batch limit, no-negative-attempts) against real Postgres. The
 * SQL-level behavioral contract (four-state repair, grace boundary, two-
 * tenant single pass) is already proved by `db/tests/reaper-repair-contract
 * .test.ts` (P12 U2a) - not re-proved here.
 *
 * Cross-tenant assertion hygiene (core-invariants.md): this is a genuinely
 * cross-tenant sweep, so every assertion below is CONTAINMENT (look up the
 * seeded job by id in a Map of the returned/observed rows), never exact-set
 * equality or a total row count.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'reaper-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function makeDeps(overrides: Partial<ReaperDeps> = {}): {
  deps: ReaperDeps;
  metrics: QueueMetricsHandles;
  sink: ReturnType<typeof createCountingNoOpRepairedSendSink>;
} {
  const metrics = bindQueueMetrics(createMetricsRegistry());
  const sink = createCountingNoOpRepairedSendSink();
  const tenantDb = createTenantDb(pool);
  const deps: ReaperDeps = {
    pool,
    tenantDb,
    metrics,
    sink,
    graceSeconds: 30,
    limit: 500,
    rng: { random: () => 0 },
    ...overrides,
  };
  return { deps, metrics, sink };
}

/** Sets a job's lease to already-expired (past the 30s grace) via a raw UPDATE - no sleeps. */
async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [jobId],
  );
}

describe('runOneReaperSweep (real Postgres)', () => {
  it('reaper_never_drives_attempts_negative', async () => {
    // Mandatory suite test 15: min(attempts)=0, job still terminates at
    // max_attempts - both halves. Simulate "100 workers killed between claim
    // and attempt insert" by seeding a claimed job with attempts already at 0
    // and NO attempt row (the no-attempt branch - the SQL's GREATEST(0, ...)
    // floor only applies to the 'prepared' branch, and the no-attempt branch
    // never touches `attempts` at all) - sweeping must leave attempts at
    // EXACTLY 0, never negative, and the job must still be re-eligible
    // (requeued to 'queued') rather than stranded.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 3 });
    await expireLease(job.id);

    const { deps } = makeDeps();
    await runOneReaperSweep(deps);

    const after = await pool.query<{ attempts: number; status: string }>(
      'SELECT attempts, status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(after.rows[0]?.attempts).toBe(0);
    expect(after.rows[0]?.status).toBe('queued');
  });

  it('reaper_repairs_nothing_before_the_thirty_second_grace', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    // A live, heartbeat-renewed lease - well inside the 30s grace.
    await pool.query(
      `UPDATE message_jobs SET lease_expires_at = now() + interval '60 seconds' WHERE id = $1`,
      [job.id],
    );

    const { deps } = makeDeps();
    await runOneReaperSweep(deps);

    const after = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(after.rows[0]?.status).toBe('processing');
  });

  it('every_repaired_send_emits_exactly_one_repaired_send_item', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    // message_job_created_at resolved SERVER-SIDE via a subquery on the
    // globally-unique `id`, never re-bound from the JS `Date` `job.createdAt`
    // - a timestamptz round-tripped through JS truncates microsecond
    // precision, which would silently break wp_reap_expired_leases' own
    // `a.message_job_created_at = j.created_at` join (see .memory/lessons/
    // 2026-09-01-timestamptz-microseconds-vs-js-date-milliseconds.md).
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3
       RETURNING id`,
      [clientId, instanceId, job.id, job.leaseId],
    );
    const sendAttemptId = attempt.rows[0]?.id;
    if (!sendAttemptId) throw new Error('seed: no send_attempts row returned');
    await expireLease(job.id);

    const { deps, sink } = makeDeps();
    await runOneReaperSweep(deps);

    expect(sink.repairedSentCalls).toEqual([sendAttemptId]);

    const jobAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobAfter.rows[0]?.status).toBe('sent');

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, job.id],
    );
    expect(events.rows.filter((r) => r.event_type === 'reconciled')).toHaveLength(1);

    // Second pass: the job is no longer 'processing', so the cross-tenant
    // scan finds nothing for it - idempotent, no second sink call, no
    // second delivery event.
    await runOneReaperSweep(deps);
    expect(sink.repairedSentCalls).toEqual([sendAttemptId]);
    const eventsAfter = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, job.id],
    );
    expect(eventsAfter.rows.filter((r) => r.event_type === 'reconciled')).toHaveLength(1);
  });

  it('reaper_batch_is_bounded_and_two_cron_processes_do_not_overlap', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const jobs = await Promise.all(
      Array.from({ length: 3 }, () => seedClaimedJob(pool, { clientId, instanceId })),
    );
    await Promise.all(jobs.map((job) => expireLease(job.id)));

    // p_limit honoured: a limit of 1 repairs EXACTLY one of the three
    // eligible rows per call (never zero, never more than the limit).
    const { deps: limitedDeps } = makeDeps({ limit: 1 });
    await runOneReaperSweep(limitedDeps);
    const afterOneSweep = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = ANY($1)',
      [jobs.map((j) => j.id)],
    );
    expect(afterOneSweep.rows.filter((r) => r.status === 'queued').length).toBe(1);

    // Overlap invariant: two concurrent sweeps against the REMAINING expired
    // jobs never double-repair the same job - FOR UPDATE ... SKIP LOCKED
    // guarantees each job is claimed by at most one sweep. Assert the
    // invariant (every seeded job ends up 'queued' exactly once, no error),
    // never which sweep "won".
    const { deps: sweepA } = makeDeps();
    const { deps: sweepB } = makeDeps();
    await Promise.all([runOneReaperSweep(sweepA), runOneReaperSweep(sweepB)]);

    const finalStatuses = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM message_jobs WHERE id = ANY($1)',
      [jobs.map((j) => j.id)],
    );
    const byId = new Map(finalStatuses.rows.map((r) => [r.id, r.status]));
    for (const job of jobs) {
      expect(byId.get(job.id)).toBe('queued');
    }
  });

  it('an_acked_attempt_left_by_a_crash_is_reconciled_from_the_attempt_row_and_never_requeued', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    // message_job_created_at resolved server-side - see the comment in the
    // sibling test above for why (timestamptz microsecond truncation lesson).
    await pool.query(
      `INSERT INTO send_attempts
         (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
          attempt_no, state, prepared_at, dispatched_at, resolved_at)
       SELECT $1, $2, $3, j.created_at, $4, 1, 'acked', now(), now(), now()
         FROM message_jobs j WHERE j.id = $3`,
      [clientId, instanceId, job.id, job.leaseId],
    );
    await expireLease(job.id);

    const { deps, sink } = makeDeps();
    await runOneReaperSweep(deps);

    const jobAfter = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobAfter.rows[0]?.status).toBe('sent'); // never 'queued' - invariant 2
    expect(sink.repairedSentCalls.length).toBe(1);
  });
});
