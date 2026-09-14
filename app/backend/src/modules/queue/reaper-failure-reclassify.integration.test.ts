import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMetricsRegistry } from '@wp/server-kit';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { bindQueueMetrics } from '../../engine/queue/metrics.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import { runOneReaperSweep, type ReaperDeps } from './reaper.js';
import { createCountingNoOpRepairedSendSink } from './repaired-send-sink.js';

/**
 * reaper-failure-reclassify.integration.test.ts (P12 C2 hardening pass) -
 * real Postgres. Migration 0029 (C1 finding 2) added a THIRD reaper repair
 * path - the `failed` attempt re-drive through `reclassifyReapedFailure`
 * (retry_scheduled / terminal / paused) - which `reaper.integration.test.ts`
 * exercises for a first sweep but never re-runs a SECOND time. Every other
 * repair branch (`acked` -> `sent`, batch-limit/overlap) has an explicit
 * idempotent-re-run assertion; this file closes that gap for the `failed`
 * branch specifically, for its RETRY_BACKOFF and FAIL_PERMANENT outcomes
 * (`errorClass` values verified against `@wp/domain`'s `classify()` table).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'reaper-failure-reclassify-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

function makeDeps(): {
  deps: ReaperDeps;
  sink: ReturnType<typeof createCountingNoOpRepairedSendSink>;
} {
  const metrics = bindQueueMetrics(createMetricsRegistry());
  const sink = createCountingNoOpRepairedSendSink();
  const tenantDb = createTenantDb(pool);
  return {
    deps: { pool, tenantDb, metrics, sink, graceSeconds: 30, limit: 500, rng: { random: () => 0 } },
    sink,
  };
}

async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    `UPDATE message_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
    [jobId],
  );
}

/** Seeds a claimed job with a crashed `failed` attempt (P11's fixtured crash state) and an expired lease. */
async function seedCrashedFailedAttempt(
  clientId: string,
  instanceId: string,
  errorClass: string,
  options: { attempts?: number; maxAttempts?: number } = {},
): Promise<{ jobId: string; leaseId: string }> {
  const job = await seedClaimedJob(pool, {
    clientId,
    instanceId,
    attempts: options.attempts ?? 1,
    maxAttempts: options.maxAttempts ?? 5,
  });
  await pool.query(
    `INSERT INTO send_attempts
       (client_id, instance_id, message_job_id, message_job_created_at, lease_id,
        attempt_no, state, prepared_at, dispatched_at, resolved_at, error_class)
     SELECT $1, $2, $3, j.created_at, $4, $5, 'failed', now(), now(), now(), $6
       FROM message_jobs j WHERE j.id = $3`,
    [clientId, instanceId, job.id, job.leaseId, options.attempts ?? 1, errorClass],
  );
  await expireLease(job.id);
  return { jobId: job.id, leaseId: job.leaseId };
}

describe('reaper failure-reclassify re-drive idempotency (real Postgres)', () => {
  it('a_retry_scheduled_failed_repair_is_a_no_op_on_the_second_sweep', async () => {
    // RETRY_BACKOFF branch: errorClass 'transient', attempts well under
    // max_attempts - reclassifies to `queued` with a scheduled next_attempt_at.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const { jobId } = await seedCrashedFailedAttempt(clientId, instanceId, 'transient', {
      attempts: 1,
      maxAttempts: 5,
    });

    const { deps } = makeDeps();
    await runOneReaperSweep(deps);

    const afterFirst = await pool.query<{ status: string; next_attempt_at: Date }>(
      'SELECT status, next_attempt_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(afterFirst.rows[0]?.status).toBe('queued');
    const firstNextAttemptAt = afterFirst.rows[0]?.next_attempt_at;

    const eventsAfterFirst = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, jobId],
    );
    expect(eventsAfterFirst.rows.filter((r) => r.event_type === 'retry_scheduled')).toHaveLength(1);

    // Second sweep: the job is now 'queued', not 'processing' - the
    // cross-tenant scan finds nothing for it (no expired lease on a queued
    // job), so the re-drive must not run again - no second delivery event,
    // no second next_attempt_at write.
    await runOneReaperSweep(deps);

    const afterSecond = await pool.query<{ status: string; next_attempt_at: Date }>(
      'SELECT status, next_attempt_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(afterSecond.rows[0]?.status).toBe('queued');
    expect(afterSecond.rows[0]?.next_attempt_at).toEqual(firstNextAttemptAt);

    const eventsAfterSecond = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, jobId],
    );
    expect(eventsAfterSecond.rows.filter((r) => r.event_type === 'retry_scheduled')).toHaveLength(
      1,
    );
  });

  it('a_terminal_failed_repair_is_a_no_op_on_the_second_sweep', async () => {
    // FAIL_PERMANENT branch: errorClass 'invalid_recipient' - reclassifies
    // straight to 'failed', terminal, regardless of attempts remaining.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const { jobId } = await seedCrashedFailedAttempt(clientId, instanceId, 'invalid_recipient', {
      attempts: 1,
      maxAttempts: 5,
    });

    const { deps } = makeDeps();
    await runOneReaperSweep(deps);

    const afterFirst = await pool.query<{ status: string; terminal_at: Date | null }>(
      'SELECT status, terminal_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(afterFirst.rows[0]?.status).toBe('failed');
    expect(afterFirst.rows[0]?.terminal_at).not.toBeNull();
    const firstTerminalAt = afterFirst.rows[0]?.terminal_at;

    const eventsAfterFirst = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, jobId],
    );
    expect(eventsAfterFirst.rows.filter((r) => r.event_type === 'failed')).toHaveLength(1);

    // Second sweep: job is terminal ('failed'), never 'processing' again -
    // the cross-tenant scan finds nothing, no second terminal write, no
    // second delivery event (never re-fails an already-terminal job).
    await runOneReaperSweep(deps);

    const afterSecond = await pool.query<{ status: string; terminal_at: Date | null }>(
      'SELECT status, terminal_at FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(afterSecond.rows[0]?.status).toBe('failed');
    expect(afterSecond.rows[0]?.terminal_at).toEqual(firstTerminalAt);

    const eventsAfterSecond = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE client_id = $1 AND message_job_id = $2`,
      [clientId, jobId],
    );
    expect(eventsAfterSecond.rows.filter((r) => r.event_type === 'failed')).toHaveLength(1);
  });

  it('a_failed_attempt_at_the_retry_budget_boundary_reclassifies_terminal_not_backoff', async () => {
    // Boundary: attempts already AT max_attempts with a RETRY_BACKOFF-class
    // error - isRetryBudgetExhausted must win over the backoff branch, same
    // arithmetic as result.ts's own budget check, re-verified through the
    // reaper's re-drive path specifically (a different code path from
    // result.ts, sharing only the imported isRetryBudgetExhausted).
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const { jobId } = await seedCrashedFailedAttempt(clientId, instanceId, 'transient', {
      attempts: 5,
      maxAttempts: 5,
    });

    const { deps } = makeDeps();
    await runOneReaperSweep(deps);

    const after = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [jobId],
    );
    expect(after.rows[0]?.status).toBe('failed');
  });
});
