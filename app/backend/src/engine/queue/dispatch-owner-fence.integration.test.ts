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

const FAST_SEND_TIMEOUT_MS = 40;
const FAST_HEARTBEAT_INTERVAL_MS = 15;

/**
 * dispatch-owner-fence.integration.test.ts (MAJOR 8 fix, P11 gate round) -
 * split out of `dispatch.integration.test.ts` at the max-lines cap (topic
 * split only, same suite conventions). Proves `send_attempts.owner_fence` is
 * now written on dispatch (Phase step 6 requires it; the shipped INSERT had
 * omitted it, leaving every P11-era row NULL) - a reaper (P12) needs this
 * column to tell whether an in-flight attempt belongs to a superseded
 * session generation.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'dispatch-owner-fence-test',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('dispatch - owner_fence (real Postgres)', () => {
  it('owner_fence_is_written_on_the_send_attempts_row_and_equals_the_claiming_fence', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedClaimedJob(pool, { clientId, instanceId, attempts: 0 });
    const tenantDb = createTenantDb(pool);
    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.fence');

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
      payloadKind: 'text',
      payload: { text: 'hello' },
      publicId: job.publicId,
      fence: 7,
    };

    await dispatch(input, {
      tenantDb,
      transport,
      clock: { now: () => Date.now() },
      sendTimeoutMs: FAST_SEND_TIMEOUT_MS,
      heartbeatIntervalMs: FAST_HEARTBEAT_INTERVAL_MS,
    });

    const attemptRow = await pool.query<{ owner_fence: string | null }>(
      'SELECT owner_fence FROM send_attempts WHERE message_job_id = $1 AND attempt_no = 1',
      [job.id],
    );
    expect(attemptRow.rows[0]?.owner_fence).not.toBeNull();
    expect(Number(attemptRow.rows[0]?.owner_fence)).toBe(7);
  });
});
