import { randomUUID } from 'node:crypto';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import {
  ClaimLostBeforeDispatch,
  DispatchAlreadyRecorded,
  dispatch,
  type DispatchInput,
} from './dispatch.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * dispatch-lease-race.integration.test.ts (C2 hardening pass, P11) - the
 * concurrency case the mandated suite does not cover: a lease stolen
 * BETWEEN a worker's claim and its call to `dispatch()`, before the
 * provider is ever invoked. `dispatch.ts`'s own `prepareAndIncrement` now
 * checks the `rowCount` of its `attempts = attempts + 1` UPDATE (matched on
 * `id = $1 AND lease_id = $2`) the same way every job-outcome write in
 * `result.ts` calls `assertJobRowTouched` - a zero-row match throws
 * `ClaimLostBeforeDispatch` BEFORE the provider is ever invoked, and because
 * this all runs inside one `withTenant` transaction, the throw rolls back
 * the `send_attempts` INSERT and the `dispatched` delivery event along with
 * it. This proves the stale-lease case now leaves nothing behind.
 */

const FAST_SEND_TIMEOUT_MS = 40;
const FAST_HEARTBEAT_INTERVAL_MS = 15;

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'dispatch-lease-race-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('dispatch - lease stolen before dispatch is called (real Postgres)', () => {
  it('a_stale_lease_id_at_dispatch_time_throws_before_the_provider_is_called_and_writes_nothing', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0 });
    const staleLeaseId = job.leaseId;

    // Simulate a second worker stealing the job: a NEW lease_id is minted
    // for the SAME row, exactly what claim-jobs.sql's
    // `SET lease_id = gen_random_uuid()` does on a fresh claim (e.g. after
    // the first worker's lease expired and the reaper/second claim
    // re-armed it). The first worker's `job.leaseId` in memory is now
    // stale - it does not match any row.
    const newLeaseId = randomUUID();
    await pool.query('UPDATE message_jobs SET lease_id = $1 WHERE id = $2', [newLeaseId, job.id]);

    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.stale-lease');

    const input: DispatchInput = {
      clientId,
      instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: staleLeaseId, // the FIRST worker's now-stolen lease
      attempts: 0,
      recipientJid: '15550000000@s.whatsapp.net',
      recipientHash: null,
      sendOrigin: null,
      payloadKind: 'text',
      payload: { text: 'hello' },
      publicId: job.publicId,
      fence: 1,
    };

    // FIXED behaviour: the attempts-increment UPDATE (WHERE id=... AND
    // lease_id=$stale) matches zero rows, so dispatch() throws
    // ClaimLostBeforeDispatch BEFORE the provider is ever invoked - the
    // stale-lease worker never sends.
    await expect(
      dispatch(input, {
        tenantDb,
        transport,
        clock: { now: () => 0 },
        sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
        heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
      }),
    ).rejects.toThrow(ClaimLostBeforeDispatch);

    // The provider was NEVER called, for a job this worker no longer
    // legitimately owns.
    expect(transport.calls).toHaveLength(0);

    // The attempts counter on the job was NOT incremented, and the lease
    // still belongs to the new (legitimate) owner.
    const jobRow = await pool.query<{ attempts: number; lease_id: string }>(
      'SELECT attempts, lease_id FROM message_jobs WHERE id = $1',
      [job.id],
    );
    expect(jobRow.rows[0]?.attempts).toBe(0);
    expect(jobRow.rows[0]?.lease_id).toBe(newLeaseId);

    // The whole transaction rolled back: no send_attempts row and no
    // dispatched delivery event survive the stale-lease attempt - a second,
    // legitimate worker dispatching attempt_no=1 under the real lease is
    // therefore not blocked by anything this worker wrote.
    const attemptRow = await pool.query<{ attempt_no: number; state: string }>(
      'SELECT attempt_no, state FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    expect(attemptRow.rows).toHaveLength(0);

    const eventRow = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM delivery_events WHERE message_job_id = $1 AND event_type = 'dispatched'`,
      [job.id],
    );
    expect(eventRow.rows).toHaveLength(0);
  });

  it('after_a_stale_lease_attempt_and_a_legitimate_dispatch_attempts_equals_max_attempt_no_exactly', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0 });
    const staleLeaseId = job.leaseId;
    const newLeaseId = randomUUID();
    await pool.query('UPDATE message_jobs SET lease_id = $1 WHERE id = $2', [newLeaseId, job.id]);

    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.stale-lease');
    transport.queueResolve(0, 'wamid.legit');

    const staleInput: DispatchInput = {
      clientId,
      instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: staleLeaseId,
      attempts: 0,
      recipientJid: '15550000000@s.whatsapp.net',
      recipientHash: null,
      sendOrigin: null,
      payloadKind: 'text',
      payload: { text: 'hello' },
      publicId: job.publicId,
      fence: 1,
    };
    const deps = {
      tenantDb,
      transport,
      clock: { now: () => 0 },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    };

    await expect(dispatch(staleInput, deps)).rejects.toThrow(ClaimLostBeforeDispatch);

    // The legitimate new owner dispatches attempt_no=1 under the real lease.
    await dispatch({ ...staleInput, leaseId: newLeaseId }, deps);

    const jobRow = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM message_jobs WHERE id = $1',
      [job.id],
    );
    const maxAttemptRow = await pool.query<{ max: number }>(
      'SELECT max(attempt_no) AS max FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    // Exact accounting identity (mandated invariant test's own assertion,
    // proved again here across a stale-lease attempt): message_jobs.attempts
    // equals max(send_attempts.attempt_no) exactly.
    expect(jobRow.rows[0]?.attempts).toBe(1);
    expect(maxAttemptRow.rows[0]?.max).toBe(1);
  });

  it('a_replayed_dispatch_call_for_the_same_attempt_no_throws_a_typed_error_rather_than_calling_the_provider_twice', async () => {
    // send_attempts carries UNIQUE (message_job_id, attempt_no) (migration
    // 0008) - the correct backstop against a double-send for the exact same
    // attempt. FIXED: prepareAndIncrement now writes that INSERT as
    // `ON CONFLICT (message_job_id, attempt_no) DO NOTHING RETURNING id` and
    // branches on rowCount, the same non-throwing approach
    // `writeDeliveryEvent` (engine/queue/delivery-event.ts) uses - never a
    // try/catch on 23505 inside the open transaction (that would abort the
    // transaction with no savepoint, turning a later COMMIT into a silent
    // ROLLBACK). This proves the provider is NOT called a second time and
    // that the caller sees a typed, documented "already dispatched" outcome
    // rather than a raw Postgres error.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.first');
    transport.queueResolve(0, 'wamid.replay');

    const input: DispatchInput = {
      clientId,
      instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: job.leaseId,
      attempts: 0, // fixed: both calls compute the SAME attemptNo (0 + 1)
      recipientJid: '15550000000@s.whatsapp.net',
      recipientHash: null,
      sendOrigin: null,
      payloadKind: 'text',
      payload: { text: 'hello' },
      publicId: job.publicId,
      fence: 1,
    };
    const deps = {
      tenantDb,
      transport,
      clock: { now: () => 0 },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    };

    const first = await dispatch(input, deps);
    expect(first.outcome).toBe('settled');
    expect(transport.calls).toHaveLength(1);

    // The replay: same jobId, same attempts (=> same attemptNo). The
    // conflicting INSERT resolves to zero rows BEFORE transport.send() is
    // ever reached (prepareAndIncrement runs inside the first, committed-
    // before-send transaction) - so the provider must NOT be called a
    // second time, and the caller sees a typed error, not a raw pg error.
    await expect(dispatch(input, deps)).rejects.toThrow(DispatchAlreadyRecorded);
    expect(transport.calls).toHaveLength(1);
  });
});
