import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFsObjectStore } from '../../platform/storage/object-store-fs.js';
import { seedMediaAsset } from '../../modules/media/__tests__/seed-media-asset.js';
import { TransportSendError } from '../../provider/provider.types.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { dispatch, type DispatchInput } from './dispatch.js';
import { resolveAck, resolveFailure, type ResultDeps } from './result.js';
import {
  cleanupSendProbeClients,
  getJobResultRow,
  seedClaimedJob,
  seedDispatchedAttempt,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * result-failure.integration.test.ts (P11 Unit U4, step 7) - real Postgres,
 * `resolveFailure` half plus the mandatory slow-media soak test. Split out
 * of `result.integration.test.ts` at the max-lines cap (topic split only -
 * `resolveAck`'s own tests are unchanged, in the sibling file).
 */

let pool: TestPool;
let probeClientIds: string[] = [];
/** P34 (2026-09-14): the slow-media soak now needs a REAL asset - dispatch resolves `mediaId` against `media_assets` and DEFERs when it is absent, so the old invented `{ mediaUrl }` payload made this test read as a dispatch failure. */
let mediaRootDir: string;

const fixedRng = { random: () => 0.5 };

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), 'wp-result-failure-media-'));
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'result-failure-test',
  });
});

afterAll(async () => {
  await pool.end();
  await rm(mediaRootDir, { recursive: true, force: true });
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('resolveFailure - real Postgres', () => {
  it('a_transient_failure_requeues_with_jittered_backoff_and_fails_nothing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
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
    // rng.random() = 0 -> backoff(1, rng) = 0 -> next_attempt_at is
    // approximately "now" (not in the past) - never 'failed'.
    expect(jobRow.next_attempt_at.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('an_invalid_recipient_is_terminal_and_never_retried', async () => {
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
    expect(jobRow.terminal_at).not.toBeNull();

    // Zero further claims: the claim statement only ever selects
    // status='queued', which this job is no longer.
    const requeued = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1 AND status = $2',
      [seeded.jobId, 'queued'],
    );
    expect(requeued.rows.length).toBe(0);
  });

  it('an_unknown_provider_error_pauses_the_instance_and_retries_nothing', async () => {
    const seeded = await seedDispatchedAttempt(pool, probeClientIds, { attempts: 0 });
    // A second, untouched job on the same instance - proves the pause
    // preserves every queued job (invariant 5/2).
    const otherJob = await seedClaimedJob(pool, {
      clientId: seeded.clientId,
      instanceId: seeded.instanceId,
    });
    await pool.query("UPDATE message_jobs SET status = 'queued' WHERE id = $1", [otherJob.id]);

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
        error: new TransportSendError('unknown', 'unrecognized provider signal'),
        recipientJid: seeded.recipientJid,
      },
      deps,
    );

    const instanceRow = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [seeded.instanceId],
    );
    expect(instanceRow.rows[0]?.health_state).toBe('paused');

    // The failed job itself was requeued (status='queued'), never 'failed'.
    const jobRow = await getJobResultRow(pool, seeded.jobId);
    expect(jobRow.status).toBe('queued');

    // Every OTHER queued job on the instance is still queued.
    const otherRow = await getJobResultRow(pool, otherJob.id);
    expect(otherRow.status).toBe('queued');
  });
});

describe('dispatch + resolveAck together - real Postgres', () => {
  it('slow_media_send_does_not_lose_its_result', async () => {
    // Mandatory suite test 14. A REAL (scaled-down) slow send: 90s
    // production timing is provable at correct RATIOS without waiting 90
    // real seconds - `sendTimeoutMs` well above the transport's real delay,
    // `heartbeatIntervalMs` short enough to renew the lease several times
    // over the flight, and the lease itself started with very little TTL
    // headroom so a heartbeat that DIDN'T fire would let it expire well
    // before the send completes. `'real-latency'` mode (fake-transport's
    // own opt-in) is used here, not fake timers -
    // dispatch.integration.test.ts's suite already established that
    // `vi.useFakeTimers()` hangs the real PG connection this test needs.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId });
    // ~80ms of lease headroom - if the heartbeat never fired, the lease
    // would already look stale well before the ~150ms send completes.
    await pool.query(
      "UPDATE message_jobs SET lease_expires_at = now() + interval '80 milliseconds' WHERE id = $1",
      [job.id],
    );

    const tenantDb = createTenantDb(pool);
    const objectStore = createFsObjectStore({ rootDir: mediaRootDir });
    const mediaId = await seedMediaAsset(pool, objectStore, clientId);
    const transport = createFakeTransport();
    transport.queueResolve(150, 'wamid.slow-media', 'real-latency');

    const input: DispatchInput = {
      clientId,
      instanceId,
      jobId: job.id,
      jobCreatedAt: job.createdAt,
      leaseId: job.leaseId,
      attempts: 0,
      recipientJid: '15550000000@s.whatsapp.net',
      recipientHash: null,
      sendOrigin: null,
      payloadKind: 'media',
      payload: { kind: 'image', mediaId },
      publicId: job.publicId,
      fence: 1,
    };

    const result = await dispatch(input, {
      tenantDb,
      transport,
      // P34: a media job resolves its bytes through the object store before
      // the precheck transaction - omitting this dep is itself a DEFER
      // (`no_object_store_configured`), not a send.
      objectStore,
      clock: { now: () => Date.now() },
      sendTimeoutMs: 5_000,
      heartbeatIntervalMs: 20,
    });

    expect(result.outcome).toBe('settled');
    expect(result.sendOutcome?.providerMsgId).toBe('wamid.slow-media');

    // The lease was renewed at least once during the flight - it must be
    // well past the original 80ms headroom by now.
    const leaseRow = await pool.query<{ still_valid: boolean }>(
      "SELECT lease_expires_at > now() + interval '1 second' AS still_valid FROM message_jobs WHERE id = $1",
      [job.id],
    );
    expect(leaseRow.rows[0]?.still_valid).toBe(true);

    const deps: ResultDeps = { tenantDb, rng: fixedRng };
    await resolveAck(
      {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attemptNo: result.attemptNo,
        publicId: job.publicId,
        outcome: result.sendOutcome ?? { providerMsgId: 'unexpected' },
        payloadKind: 'text',
        recipientJid: '15550000000@s.whatsapp.net',
      },
      deps,
    );

    const jobRow = await getJobResultRow(pool, job.id);
    expect(jobRow.status).toBe('sent');
    expect(jobRow.sent_at).not.toBeNull();

    const waIdRows = await pool.query(
      'SELECT 1 FROM message_wa_ids WHERE client_id = $1 AND instance_id = $2',
      [clientId, instanceId],
    );
    expect(waIdRows.rows.length).toBe(1);

    const attemptRows = await pool.query('SELECT 1 FROM send_attempts WHERE message_job_id = $1', [
      job.id,
    ]);
    expect(attemptRows.rows.length).toBe(1); // zero duplicates.
  });
});
