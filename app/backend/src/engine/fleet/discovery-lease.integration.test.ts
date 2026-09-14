import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createDiscoveryLoop } from './discovery.js';
import {
  type Pool,
  cleanupProbeClients,
  seedInstance,
  makeDiscoveryDeps,
} from './__tests__/discovery-integration-test-support.js';

/**
 * discovery-lease.integration.test.ts (P09 Unit U3 step 5, FIX-P09-B split) -
 * the live-lease exclusion case, split out of `discovery.integration.test.ts`
 * at FIX-P09-B for the max-lines cap (topic split only - same case,
 * unchanged). Real Postgres + Redis proofs - see
 * `discovery-escalation.integration.test.ts` for the escalation/two-tenant
 * cases and `discovery-integration-test-support.ts` for the shared
 * seed/cleanup/makeDeps helpers.
 */

let pool: Pool;
let redis: ReturnType<typeof createRedis>;
const probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    await cleanupProbeClients(pool, probeClientIds);
    probeClientIds.length = 0;
  }
});

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
});

describe('discovery loop - real Postgres + Redis', () => {
  it('discovery_never_returns_an_instance_with_a_live_lease', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'discovery-test',
    });
    redis = createRedis(resolveRedisUrl());

    const fresh = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Discovery Probe Fresh',
      label: 'fresh',
    });
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
       VALUES ($1, $2, 1, 'worker-x', now())`,
      [fresh.instanceId, fresh.clientId],
    );

    const stale = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Discovery Probe Stale',
      label: 'stale',
    });
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
       VALUES ($1, $2, 1, 'worker-y', now() - interval '10 seconds')`,
      [stale.instanceId, stale.clientId],
    );

    const seenInstanceIds: string[] = [];
    const deps = makeDiscoveryDeps(pool, redis, {
      grab: async (row) => {
        seenInstanceIds.push(row.instanceId);
        return true; // grabbed, so no escalation bookkeeping side effects.
      },
    });
    const loop = createDiscoveryLoop(deps);
    await loop.runOneCycle();

    expect(seenInstanceIds).not.toContain(fresh.instanceId);
    expect(seenInstanceIds).toContain(stale.instanceId);
  });
});
