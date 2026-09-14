import { createPool } from '@wp/db';
import { applyDisconnect } from '@wp/domain';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { applyEngineTransition, type InstanceServiceDeps } from './service.js';
import {
  PROBE_WORKER_ID,
  cleanupProbeClients,
  ctxFor,
  readJobsForInstance,
  seedJob,
  seedLease,
  seedTenant,
  type TestPool,
} from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.pause-preserves-jobs.integration.test.ts (P08 Unit
 * U4) - core invariant 5 (pause preserves work): applying the restriction-
 * pause (403) transition must never touch any already-queued `message_jobs`
 * row for the instance - not its status, not its `updated_at`.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

describe('restriction pause leaves every queued job untouched', () => {
  it('restriction_pause_leaves_every_queued_job_untouched', async () => {
    const { clientId, instanceId } = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(clientId);
    const fence = 13n;
    await seedLease(pool, { clientId, instanceId, fence });

    await seedJob(pool, { clientId, instanceId });
    await seedJob(pool, { clientId, instanceId });
    await seedJob(pool, { clientId, instanceId });

    const before = await readJobsForInstance(pool, instanceId);
    expect(before).toHaveLength(3);
    expect(before.every((job) => job.status === 'queued')).toBe(true);

    const deps: InstanceServiceDeps = { ctx: ctxFor(pool, clientId), auditSql: pool as never };
    const transition = applyDisconnect(
      {
        healthState: 'connected',
        linkState: 'linked',
        autoReconnect: false,
        budget: null,
        action: 'restriction',
        surfaceAsError: true,
      },
      { restart515Used: 0, unknownAttempts: 0 },
    );

    await applyEngineTransition(deps, instanceId, 'connected', transition, {
      fence,
      workerId: PROBE_WORKER_ID,
      code: '403',
    });

    const after = await readJobsForInstance(pool, instanceId);
    expect(after).toEqual(before);
  });
});
