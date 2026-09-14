import { createPool, createTenantDb } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { dispatch, type DispatchInput } from './dispatch.js';
import {
  cleanupSendProbeClients,
  seedClaimedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * dispatch.integration.test.ts (P11 Unit U4, step 6) - real Postgres, fake
 * transport. Deliberately does NOT use `vi.useFakeTimers()`: Postgres'
 * client driver schedules its own real `setTimeout`s for the live
 * connection this suite needs, and globally faking timers hangs every
 * query indefinitely (proved directly - even scoping `toFake` to
 * `setTimeout`/`setInterval` only still hangs `pg`). Instead, every test
 * injects a small REAL `sendTimeoutMs`/`heartbeatIntervalMs` (tens of
 * milliseconds, not the production 45s) via `dispatch`'s own deps - the
 * production constant (`TIMING.sendTimeoutMs`) is proved separately, as an
 * exact value, in `packages/domain/src/timing.test.ts`. This keeps the
 * suite fast and deterministic (no `vi.useFakeTimers()`, but also no
 * arbitrary real sleeps beyond the tiny injected timeout itself) without
 * fighting the real PG connection's own timers.
 */

const FAST_SEND_TIMEOUT_MS = 40;
const FAST_HEARTBEAT_INTERVAL_MS = 15;

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'dispatch-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

async function seedInput(overrides: { attempts?: number } = {}): Promise<DispatchInput> {
  const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
  const job = await seedClaimedJob(pool, {
    clientId,
    instanceId,
    attempts: overrides.attempts ?? 0,
  });
  return {
    clientId,
    instanceId,
    jobId: job.id,
    jobCreatedAt: job.createdAt,
    leaseId: job.leaseId,
    attempts: overrides.attempts ?? 0,
    recipientJid: '15550000000@s.whatsapp.net',
    recipientHash: null,
    sendOrigin: null,
    payloadKind: 'text',
    payload: { text: 'hello' },
    publicId: job.publicId,
    fence: 1,
  };
}

describe('dispatch - real Postgres', () => {
  it('an_attempt_row_exists_before_the_provider_is_called', async () => {
    const input = await seedInput();
    const tenantDb = createTenantDb(pool);

    let observedState: string | undefined;
    const transport = createFakeTransport({
      onSend: () => {
        // onSend fires synchronously, before any timer - the send_attempts
        // row from step 1 has already committed by the time transport.send
        // is invoked, so a query issued right here must see it.
      },
    });
    const originalSend = transport.send.bind(transport);
    transport.send = async (instanceId, msg) => {
      const result = await pool.query<{ state: string }>(
        'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = 1',
        [input.jobId],
      );
      observedState = result.rows[0]?.state;
      return originalSend(instanceId, msg);
    };
    transport.queueResolve(0, 'wamid.1');

    await dispatch(input, {
      tenantDb,
      transport,
      clock: { now: () => Date.now() },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    });

    expect(observedState).toBe('dispatched');
  });

  it('attempts_increments_exactly_once_per_attempt_row', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0, maxAttempts: 100 });
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();

    const attemptCount = 5;
    for (let i = 0; i < attemptCount; i++) {
      transport.queueResolve(0, `wamid.${String(i)}`);
      const input: DispatchInput = {
        clientId,
        instanceId,
        jobId: job.id,
        jobCreatedAt: job.createdAt,
        leaseId: job.leaseId,
        attempts: i,
        recipientJid: '15550000000@s.whatsapp.net',
        recipientHash: null,
        sendOrigin: null,
        payloadKind: 'text',
        payload: { text: 'hello' },
        publicId: job.publicId,
        fence: 1,
      };
      await dispatch(input, {
        tenantDb,
        transport,
        clock: { now: () => 0 },
        sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
        heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
      });
    }

    const jobRow = await pool.query<{ attempts: number }>(
      'SELECT attempts FROM message_jobs WHERE id = $1',
      [job.id],
    );
    const maxAttemptRow = await pool.query<{ max: number }>(
      'SELECT max(attempt_no) AS max FROM send_attempts WHERE message_job_id = $1',
      [job.id],
    );
    // Exact accounting identity: attempts on the job equals the highest
    // attempt_no recorded, equals the exact number of dispatch calls made.
    expect(jobRow.rows[0]?.attempts).toBe(attemptCount);
    expect(maxAttemptRow.rows[0]?.max).toBe(attemptCount);
  });

  it('a_crash_between_claim_and_dispatch_leaves_a_prepared_attempt_and_a_processing_job', async () => {
    const input = await seedInput();
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueNeverResolves();

    // Nothing in THIS phase repairs a crash mid-flight (P12's reaper does) -
    // this test only proves the state left behind is exactly the state
    // P12 is written against: a 'dispatched' attempt row (dispatched_at
    // already stamped, since step 2 ran) and a still-'processing' job.
    const dispatchPromise = dispatch(input, {
      tenantDb,
      transport,
      clock: { now: () => Date.now() },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    });

    // A few ms in (well before the fast timeout fires), the crash-equivalent
    // state is already durable - check it concurrently with the in-flight
    // (never-resolving-until-timeout) send.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const attemptRow = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = 1',
      [input.jobId],
    );
    expect(attemptRow.rows[0]?.state).toBe('dispatched');

    const jobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [input.jobId],
    );
    expect(jobRow.rows[0]?.status).toBe('processing');

    await dispatchPromise; // let the fast timeout settle before the test ends.
  });

  it('a_send_timeout_at_45s_never_calls_the_provider_twice', async () => {
    const input = await seedInput();
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueNeverResolves();

    const result = await dispatch(input, {
      tenantDb,
      transport,
      clock: { now: () => Date.now() },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    });

    expect(result.outcome).toBe('timed_out');
    expect(transport.calls.length).toBe(1);

    const attemptRow = await pool.query<{ state: string }>(
      'SELECT state FROM send_attempts WHERE message_job_id = $1 AND attempt_no = 1',
      [input.jobId],
    );
    expect(attemptRow.rows[0]?.state).toBe('dispatched');
  });

  // The interim pacing floor's own "blocks a second dispatch before it
  // elapses" case (previously here) was DELETED along with `engine/queue/
  // interim-gap.ts` (P13): dispatch() no longer gates on any pacing
  // mechanism of its own - the real durable pacing reserve now runs inside
  // the claim transaction, strictly before dispatch() is ever called (see
  // `send-loop.ts`'s own module doc). The min-gap invariant this test used
  // to prove at the dispatch layer is now proved at the reserve layer
  // instead - `engine/pacing/reserve-clock.integration.test.ts`'s
  // `min_gap_is_never_violated_under_parallelism`.
});
