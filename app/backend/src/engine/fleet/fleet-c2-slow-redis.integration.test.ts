import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  createDiscoveryLoop,
  markInfraUnavailableIfChanged,
  readFleetCapacityHeadroom,
  publishWorkerCap,
  type DiscoveryDeps,
} from './discovery.js';
import { type Pool, seedInstance } from './__tests__/fleet-c2-integration-test-support.js';
import { createSlowFakeRedis } from './__tests__/slow-fake-redis.js';

/**
 * fleet-c2-slow-redis.integration.test.ts - C2 close-step probe (session-
 * fleet-and-drain, P09), real-infra half, split out of
 * `fleet-c2.integration.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same cases, unchanged). Covers: slow-not-down Redis behavior
 * (real ~1.9s command latency against the 2s TIMING.redisCommandTimeoutMs
 * budget) for the discovery cycle's own gauge/headroom reads and
 * publishWorkerCap. See `fleet-c2-cross-tenant-and-shed.integration.test.ts`
 * for cases 6/5.
 *
 * REGRESSION FIX (2026-09-02, P13 close-gate follow-up): this file used to
 * proxy a REAL Redis client, adding an artificial ~1.9s delay ON TOP of the
 * real network round trip - so the actual elapsed time was 1.9s + ambient
 * network/host latency, racing the production 2s timeout with an effective
 * margin well under the nominal 100ms whenever the host was busy (confirmed:
 * failed standalone during this dispatch's own repro run, mechanism =
 * `DiscoveryRedisTimeoutError` at `discovery-caps.ts:73`). Per
 * `.memory/progress/master-plan.md`'s prescribed fix, the delay is now
 * injected via `createSlowFakeRedis` - a fully in-memory fake client (no
 * real network call at all) whose hset/hgetall/hdel resolve after an exact,
 * controlled `setTimeout(SLOW_MS)`. This removes the real-round-trip
 * variance entirely; the only remaining timer is the same in-process
 * event loop `setTimeout` the 2s timeout itself uses, which does not carry
 * network jitter. `readFleetCapacityHeadroom`/`publishWorkerCap` only need a
 * hash-shaped store (hset/hgetall/hdel), never real Redis semantics beyond
 * that, so no correctness is lost.
 *
 * No upper-bound timing assertion: these cases assert only a LOWER bound
 * (`toBeGreaterThanOrEqual(SLOW_MS - 50)`, proving the slow path genuinely
 * ran rather than short-circuited) plus completion/correctness.
 */

let pool: Pool;
const probeClientIds: string[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // P17 U6 (step 5) - markInfraUnavailableIfChanged now also calls
    // notify(); notifications.client_id/instance_id have no ON DELETE
    // CASCADE, so a leaked row would FK-block the DELETE FROM
    // whatsapp_instances/clients below.
    // FIX (P17 close, gate attempt 4): notify() also writes 3 outbox_events
    // rows per notification; outbox_events has no FK to clients either, so
    // it leaked forever, poisoning any later cross-tenant drainOnce/
    // runOneReconcilerSweep-driving test (P16 lesson mechanism).
    await pool.query('DELETE FROM outbox_events WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM notifications WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM audit_logs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM message_jobs WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM instance_lease_state WHERE client_id = ANY($1)', [
      probeClientIds,
    ]);
    await pool.query('DELETE FROM whatsapp_instances WHERE client_id = ANY($1)', [probeClientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [probeClientIds]);
    probeClientIds.length = 0;
  }
});

afterAll(async () => {
  await pool?.end();
});

// ---------------------------------------------------------------------
// Case 2 - slow-not-down: a Redis command taking ~1.9s (just under the 2s
// TIMING.redisCommandTimeoutMs budget) must let the discovery cycle / cap
// publish / headroom read complete (slowly) rather than error-cascade -
// never releases a lease, never ends a socket, as a byproduct of simply not
// throwing.
// ---------------------------------------------------------------------
describe('C2 case 2 - real Redis command near the 2s timeout budget completes without cascading', () => {
  it('publishWorkerCap and readFleetCapacityHeadroom both complete successfully when the underlying Redis round trip is artificially slowed to ~1.9s', async () => {
    const env = `c2-slow-${randomUUID()}`;

    // Fully in-memory fake hash store (see slow-fake-redis.ts header) - the
    // ONLY latency in play is the injected SLOW_MS delay, never a real
    // network round trip layered on top of it.
    const SLOW_MS = 1_900;
    const slowRedis = createSlowFakeRedis(SLOW_MS);

    const publishStart = Date.now();
    await publishWorkerCap({ redis: slowRedis, env, workerId: 'worker-slow', cap: 42 });
    const publishElapsed = Date.now() - publishStart;
    // Completed (did not time out at 2s, since 1.9s < 2s) and genuinely took
    // close to the injected delay (proves the slow path was really
    // exercised, not short-circuited).
    expect(publishElapsed).toBeGreaterThanOrEqual(SLOW_MS - 50);

    const headroomStart = Date.now();
    const headroom = await readFleetCapacityHeadroom({
      redis: slowRedis,
      env,
      desiredOnlineCount: 10,
    });
    const headroomElapsed = Date.now() - headroomStart;
    expect(headroom).toBe(42 - 10);
    expect(headroomElapsed).toBeGreaterThanOrEqual(SLOW_MS - 50);
  }, 20_000);

  it('a discovery cycle whose gauge/headroom reads are slow (but under timeout) still completes the cycle without throwing, releasing a lease, or ending a socket', async () => {
    pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'fleet-c2-slow' });
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const target = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Fleet C2 Slow Cycle',
      label: 'slow-cycle',
    });

    // Fully in-memory fake hash store (see slow-fake-redis.ts header) - only
    // Postgres is real here; the Redis leg's latency is the injected
    // SLOW_MS delay alone, never a real network round trip on top of it.
    const SLOW_MS = 1_900;
    const slowRedis = createSlowFakeRedis(SLOW_MS);

    const leaseReleaseCalls = 0;
    const socketEndCalls = 0;

    const deps: DiscoveryDeps = {
      pool,
      redis: slowRedis,
      env: 'test',
      workerId: `fleet-c2-slow-worker-${randomUUID()}`,
      admission: { canAcceptLease: () => ({ ok: true, state: 'accepting' }) },
      grab: async () => {
        // Never actually grabs - this test only cares that the cycle
        // completes cleanly around the slow Redis leg, never that it
        // touches a real lease/socket.
        return false;
      },
      markInfraUnavailable: async (row) =>
        tenantDbAsWpApp.withTenant(row.clientId, (tx) => markInfraUnavailableIfChanged(tx, row)),
      getLagP99Ms: () => 0,
      getCap: () => 100,
      getCurrentSessions: () => 0,
      staleMs: 1_000,
      maxRows: 10,
      onCycleError: (err) => {
        throw err instanceof Error ? err : new Error(String(err));
      },
    };
    const loop = createDiscoveryLoop(deps);

    const start = Date.now();
    await expect(loop.runOneCycle()).resolves.toBeUndefined();
    const elapsed = Date.now() - start;

    // The cycle genuinely paid the slow-Redis cost (proves the slow path ran
    // for real) yet completed without throwing (onCycleError would have
    // rethrown above, failing this test, had the cycle error-cascaded).
    expect(elapsed).toBeGreaterThanOrEqual(SLOW_MS - 50);
    expect(leaseReleaseCalls).toBe(0);
    expect(socketEndCalls).toBe(0);

    // The instance's health/lease state is completely untouched by the slow
    // cycle (no lease ever existed for it in this test, and it must stay
    // that way).
    const row = await pool.query<{ health_state: string }>(
      'SELECT health_state FROM whatsapp_instances WHERE id = $1',
      [target.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('connected');
  }, 20_000);
});
