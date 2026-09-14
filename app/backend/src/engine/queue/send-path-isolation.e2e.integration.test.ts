import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { createDwrrSelector } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createFakeTransport } from '../../provider/__test-support__/fake-transport.js';
import { runOneSendLoopIteration } from './send-loop.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';
import { seedSecondInstance, sendLoopDepsUsing } from './__tests__/send-path-e2e-test-support.js';

/**
 * send-path-isolation.e2e.integration.test.ts (P11 Unit U6b) - invariant 4
 * (tenant/instance isolation) proved end-to-end: one PAUSED instance of a
 * workspace must never block a SIBLING instance of the SAME workspace from
 * draining its own queue. Proved directly at `claim-jobs.sql`'s own
 * eligibility predicate (`i.health_state = 'connected'`), which
 * `pauseInstanceForResult` sets to `'paused'` - the exact write P11 U4's
 * `result.ts` issues on a `PAUSE_INSTANCE` outcome.
 */

let pool: TestPool;
let tenantDb: TenantDb;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'send-path-isolation-test',
  });
  tenantDb = createTenantDb(pool);
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('send-path e2e - one paused instance never blocks its sibling (P11 U6b, invariant 4)', () => {
  it('two_instances_of_one_workspace_drain_independently', async () => {
    const { clientId, instanceId: pausedInstanceId } = await seedSendTenant(pool, probeClientIds, {
      healthState: 'paused',
    });
    const activeInstanceId = await seedSecondInstance(pool, clientId, { healthState: 'connected' });

    const pausedJob = await seedQueuedJob(pool, { clientId, instanceId: pausedInstanceId });
    const activeJob = await seedQueuedJob(pool, { clientId, instanceId: activeInstanceId });

    const transport = createFakeTransport();
    transport.queueResolve(0, 'wamid.active-instance-1');

    // The PAUSED instance: claimOne must yield zero rows - its job stays
    // queued, never lost (invariant 5).
    const pausedResult = await runOneSendLoopIteration(
      sendLoopDepsUsing(
        pool,
        tenantDb,
        clientId,
        pausedInstanceId,
        1,
        transport,
        createDwrrSelector(),
      ),
    );
    expect(pausedResult).toEqual({ claimed: false });

    // The ACTIVE instance of the SAME workspace: drains normally, wholly
    // unaffected by its sibling's pause.
    const activeResult = await runOneSendLoopIteration(
      sendLoopDepsUsing(
        pool,
        tenantDb,
        clientId,
        activeInstanceId,
        1,
        transport,
        createDwrrSelector(),
      ),
    );
    expect(activeResult).toEqual({ claimed: true });

    const pausedJobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [pausedJob.id],
    );
    expect(pausedJobRow.rows[0]?.status).toBe('queued');

    const activeJobRow = await pool.query<{ status: string }>(
      'SELECT status FROM message_jobs WHERE id = $1',
      [activeJob.id],
    );
    expect(activeJobRow.rows[0]?.status).toBe('sent');
  });
});
