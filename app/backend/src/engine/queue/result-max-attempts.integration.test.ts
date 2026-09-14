import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { resolveFailure, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedDispatchedAttempt,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-max-attempts.integration.test.ts (C2 hardening pass, P11; flipped
 * green in the CRITICAL 2 gate-round fix) - the retry-matrix edge the
 * mandated suite never exercised: what `resolveFailure` does once `attempts`
 * has already reached `maxAttempts`. `ResolveFailureInput` carries
 * `maxAttempts`, and `result.ts` now enforces it: a `RETRY_BACKOFF` failure
 * whose `attemptNo` has reached the budget goes terminal instead of
 * requeuing forever (see `result.ts`'s own module doc for the exact
 * arithmetic - `attemptNo` mirrors the live `message_jobs.attempts` column,
 * since `dispatch.ts`'s own increment already committed before this file's
 * caller ever runs).
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-max-attempts-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveFailure - max_attempts boundary (real Postgres)', () => {
  it('a_transient_failure_at_exactly_max_attempts_goes_terminal_instead_of_requeuing_forever', async () => {
    // seedDispatchedAttempt seeds message_jobs.attempts = options.attempts
    // and the send_attempts row for attemptNo = attempts + 1. Seeding
    // attempts: 5 with maxAttempts: 5 means this attempt IS attemptNo 6,
    // one past the budget - exhausted, so this failure must be terminal.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, {
      attempts: 5,
      maxAttempts: 5,
    });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: { random: () => 0 } };

    await resolveFailure(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        attempts: 5,
        maxAttempts: 5,
        error: new TransportSendError('transient', 'still failing'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    // Fixed behaviour: result.ts now reads ResolveFailureInput.maxAttempts
    // and routes an exhausted RETRY_BACKOFF failure to the same terminal
    // shape FAIL_PERMANENT uses, instead of requeuing past the budget.
    expect(jobRow.status).toBe('failed');
    expect(jobRow.terminal_at).not.toBeNull();
    expect(jobRow.failed_at).not.toBeNull();
  });

  it('a_transient_failure_past_max_attempts_plus_one_violates_the_db_attempts_range_check_on_the_next_dispatch', async () => {
    // dispatch.ts's own `attempts = attempts + 1` UPDATE has no upper bound
    // of its own - the mj_attempts_range CHECK (attempts <= max_attempts + 1)
    // is the DB-level backstop, not the app's own exhaustion decision
    // (result.ts now stops well before this, at attemptNo == maxAttempts -
    // see the test above). This proves the backstop itself is real and
    // reachable, not hypothetical: a raw UPDATE that models exactly what
    // dispatch.ts's prepareAndIncrement would do for a THIRD attempt on a
    // job already at attempts = maxAttempts + 1 is rejected by Postgres
    // itself, independent of whether the app-level guard ever lets a real
    // caller reach this state.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, {
      attempts: 6, // one past maxAttempts (5) - a state the app-level guard
      // now prevents in practice, but the CHECK must hold regardless.
      maxAttempts: 5,
    });

    await expect(
      pool.query('UPDATE message_jobs SET attempts = attempts + 1 WHERE id = $1', [seeded.jobId]),
    ).rejects.toMatchObject({
      code: '23514', // check_violation
      constraint: 'mj_attempts_range',
    });
  });

  it('a_retry_scheduled_job_carries_a_null_failed_at_since_it_never_failed', async () => {
    // CRITICAL 4 fix: resolveFailure's RETRY_BACKOFF branch no longer writes
    // `failed_at` on the SAME UPDATE that sets status back to 'queued'
    // (result.ts's requeue branch) - `failed_at` is now reserved for the
    // genuinely-terminal branch only, so a dashboard "recent errors" query
    // filtering `failed_at IS NOT NULL` can no longer see a job that is
    // merely retrying and will still legitimately reach 'sent'.
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, {
      attempts: 0,
      maxAttempts: 5,
    });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: { random: () => 0 } };

    await resolveFailure(
      {
        clientId: seeded.clientId,
        instanceId: seeded.instanceId,
        jobId: seeded.jobId,
        jobCreatedAt: seeded.jobCreatedAt,
        leaseId: seeded.leaseId,
        attemptNo: seeded.attemptNo,
        publicId: seeded.publicId,
        attempts: 1,
        maxAttempts: 5,
        error: new TransportSendError('transient', 'network blip'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('queued');
    expect(jobRow.failed_at).toBeNull();
    expect(jobRow.terminal_at).toBeNull();
  });
});
