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
 * result-pause-hold.integration.test.ts (CRITICAL 4 fix, P11 gate round) -
 * split out of `result-failure.integration.test.ts` at the max-lines cap
 * (topic split only, same suite conventions). Proves the PAUSE_INSTANCE
 * branch no longer contradicts itself: `failed_at` is reserved for the
 * genuinely-terminal branch, and the durable trail writes `paused_hold`
 * (never `retry_scheduled`) for a restricted/unknown provider signal.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

const fixedRng = { random: () => 0.5 };

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-pause-hold-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveFailure - PAUSE_INSTANCE no longer contradicts itself (real Postgres)', () => {
  it('a_restricted_outcome_writes_no_retry_scheduled_event', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

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
        error: new TransportSendError('restricted', 'provider restriction signal'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1',
      [seeded.jobId],
    );
    const eventTypes = events.rows.map((r) => r.event_type);
    expect(eventTypes).toContain('paused_hold');
    expect(eventTypes).not.toContain('retry_scheduled');
  });

  it('a_restricted_outcome_leaves_failed_at_null_keeps_the_job_queued_and_pauses_the_instance', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

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
        error: new TransportSendError('restricted', 'provider restriction signal'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('queued');
    expect(jobRow.failed_at).toBeNull();

    const instanceRow = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(instanceRow.rows[0]?.health_state).toBe('paused');
  });

  it('a_transient_outcome_leaves_failed_at_null_and_schedules_a_future_retry', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

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
    expect(jobRow.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM delivery_events WHERE message_job_id = $1',
      [seeded.jobId],
    );
    expect(events.rows.map((r) => r.event_type)).toContain('retry_scheduled');
  });

  it('the_terminal_branch_sets_both_failed_at_and_terminal_at', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const deps: ResultDeps = { tenantDb, rng: fixedRng };

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
        error: new TransportSendError('invalid_recipient', 'no such number'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('failed');
    expect(jobRow.failed_at).not.toBeNull();
    expect(jobRow.terminal_at).not.toBeNull();
  });
});
