import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import { createMetricsRegistry } from '@wp/server-kit';
import { bindQueueMetrics } from './metrics.js';
import { buildSendLoopWorkerWiring } from './send-loop-worker-wiring.js';
import { claimOne } from '../../modules/queue/queue.repo.js';
import {
  cleanupSendProbeClients,
  seedQueuedJob,
  seedSendTenant,
  type TestPool,
} from './__tests__/queue-send-test-helpers.js';

/**
 * send-loop-worker-wiring.rls.integration.test.ts (P11 C1 CRITICAL fix) -
 * proves `buildSendLoopWorkerWiring`'s `runOneIteration` claims a real job
 * under the ACTUAL production role (`wp_scheduler`), which requires
 * `app.client_id` to be set via `TenantDb.withTenant` before `claimOne`
 * runs (RLS is `FORCE`d on `message_jobs` - migration 0007). The dev pool
 * connects as the superuser `wp` (`rolbypassrls = true`), which is why the
 * whole rest of the suite is blind to a raw-pool regression here - only a
 * role-scoped connection (`wp_scheduler`, `rolbypassrls = false`) can prove
 * or disprove this.
 *
 * `asSchedulerPool` below wraps the dev/test superuser pool with a
 * `SET LOCAL ROLE wp_scheduler` inside its own throwaway `BEGIN`/`COMMIT`
 * per query (a plain session-scoped `SET ROLE` is repo-banned -
 * `wp/no-plain-set`, transaction pooling makes it a cross-tenant leak; this
 * mirrors production, where `ROLE=session-worker` connects to Postgres
 * already authenticated as `wp_scheduler`, so a query issued straight off
 * the pool - no `tenantDb.withTenant` wrapper - runs as `wp_scheduler` with
 * no `app.client_id` GUC, exactly what this wrapper reproduces). Handing
 * THAT pool to `deps.pool` and asserting a claim still succeeds is only
 * possible if the fix routes the claim/readMaxAttempts calls through
 * `deps.tenantDb.withTenant` (which ALSO runs under `wp_scheduler`, but
 * sets `app.client_id` first) rather than querying `deps.pool` directly.
 */

let pool: TestPool;
let probeClientIds: string[] = [];

beforeAll(() => {
  pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'rls-wiring-test' });
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await cleanupSendProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

/**
 * A `pg.Pool`-shaped wrapper (only `.query()` is used by this file's
 * production code paths) whose every query runs as `wp_scheduler`, with NO
 * `app.client_id` GUC ever set - proving the fix must reach for
 * `tenantDb.withTenant` instead of querying this pool directly.
 * `SET LOCAL ROLE` (the only repo-sanctioned role-switch form,
 * `wp/no-plain-set`) requires its own transaction, so each call opens one
 * throwaway `BEGIN`/`COMMIT` around itself - this is still a faithful
 * stand-in for "a raw pool query under wp_scheduler with no GUC": the
 * production code paths under test (`readMaxAttempts`/a raw-pool `claimOne`
 * ctx) each already issue exactly one autocommitted statement.
 */
function asSchedulerPool(realPool: TestPool): TestPool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const client = await realPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE wp_scheduler');
        const result = await client.query(sql, params as unknown[] | undefined);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  } as unknown as TestPool;
}

describe('buildSendLoopWorkerWiring - real wp_scheduler role + RLS', () => {
  it('the_send_loop_claims_under_the_real_wp_scheduler_role_with_rls_forced', async () => {
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await seedQueuedJob(pool, { clientId, instanceId });

    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');
    const registry = createMetricsRegistry();
    const metrics = bindQueueMetrics(registry);

    const wiring = buildSendLoopWorkerWiring({
      env: 'test',
      workerId: 'worker-rls-1',
      pool: asSchedulerPool(pool),
      tenantDb: tenantDbAsScheduler,
      redisCtl: { duplicate: () => ({}) } as never,
      metrics,
      safetyPollMs: 30_000,
      rng: { random: () => 0.5 },
    });

    const result = await wiring.runOneIteration(clientId, instanceId, 1n, undefined as never);

    expect(result.claimed).toBe(true);
  });

  it('a_raw_pool_claim_under_wp_scheduler_without_the_guc_returns_zero_rows', async () => {
    // Regression sentinel: proves this test suite has teeth. If someone
    // reverts buildSendLoopWorkerWiring to hand claimOne a raw pool (no
    // set_config('app.client_id', ...)), THIS is what would happen -
    // silent, permanent zero-claims-forever under wp_scheduler.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    await seedQueuedJob(pool, { clientId, instanceId });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE wp_scheduler');
      // Deliberately NO set_config('app.client_id', ...) call.

      const claimed = await claimOne(
        { clientId, sql: client },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'worker-rls-1',
          claimExpiryMs: 30_000,
        },
      );

      expect(claimed).toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('tenantDb_withTenant_sets_the_guc_so_the_same_raw_query_now_sees_the_row', async () => {
    // Direct proof of the mechanism buildSendLoopWorkerWiring now relies
    // on: createTenantDbAsRole (SET LOCAL ROLE + set_config, same
    // transaction) makes the identical claim succeed where the negative
    // test above returned undefined.
    const { clientId, instanceId } = await seedSendTenant(pool, probeClientIds);
    const job = await seedQueuedJob(pool, { clientId, instanceId });
    const tenantDbAsScheduler = createTenantDbAsRole(pool, 'wp_scheduler');

    const claimed = await tenantDbAsScheduler.withTenant(clientId, (tx) =>
      claimOne(
        { clientId, sql: tx },
        {
          instanceId,
          band: 3,
          fence: 1,
          workerId: 'worker-rls-1',
          claimExpiryMs: 30_000,
        },
      ),
    );

    expect(claimed?.id).toBe(job.id);
  });
});
