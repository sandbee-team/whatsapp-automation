import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool, createTenantDb } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  createDiscoveryLoop,
  markInfraUnavailableIfChanged,
  type DiscoveryDeps,
} from './discovery.js';
import { LeaseManager } from '../lease/lease-manager.js';
import { createLeaseRedis } from '../lease/lease-redis.js';
import type { SessionOwner } from '../lease/session-owner.port.js';
import { createSessionRegistry, type RunnerHandle } from '../session/registry.js';
import { buildShedPortsWithLeaseLookup } from '../session/fleet-adapters.js';
import { shedVictims } from './shed.js';
import {
  type Pool,
  seedInstance,
  COMPRESSED_TIMING,
} from './__tests__/fleet-c2-integration-test-support.js';

/**
 * fleet-c2-cross-tenant-and-shed.integration.test.ts - C2 close-step probe
 * (session-fleet-and-drain, P09), real-infra half, split out of
 * `fleet-c2.integration.test.ts` at FIX-P09-B for the max-lines cap (topic
 * split only - same cases, unchanged). Covers: the cross-tenant escalation-
 * audit isolation variant of the E3 pass's same-tenant contested-instance
 * case; and the shed -> re-scan same-worker anti-churn question against REAL
 * LeaseManager + Postgres + Redis (the end-to-end confirmation of
 * fleet-c2-unit-shed-and-cap.test.ts's adapter-level pin). See
 * `fleet-c2-slow-redis.integration.test.ts` for case 2.
 */

let pool: Pool;
let redis: ReturnType<typeof createRedis>;
const probeClientIds: string[] = [];
const redisHandles: ReturnType<typeof createRedis>[] = [];

afterEach(async () => {
  if (probeClientIds.length > 0) {
    // P17 U6 (step 5) - markInfraUnavailableIfChanged also calls notify(),
    // which writes notifications + 3 outbox_events rows; neither has an ON
    // DELETE CASCADE, so a leaked row would FK-block the deletes below and
    // poison any later cross-tenant drainOnce (P16 lesson mechanism).
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
  redis?.disconnect();
  for (const h of redisHandles) {
    h.disconnect();
  }
});

// ---------------------------------------------------------------------
// Case 6 - two-tenant: extend E3 case 22 (same-tenant contested instances)
// to the CROSS-TENANT variant - two different clients' instances, each
// independently crossing the 3-cycle escalation threshold under two
// CONCURRENT discovery loops (simulating two workers), must each get
// exactly their OWN audit row, scoped to their OWN client_id, never a
// cross-tenant leak or a row attributed to the wrong tenant.
// ---------------------------------------------------------------------
describe('C2 case 6 - cross-tenant escalation audit isolation under concurrent discovery cycles', () => {
  it('tenant A instance escalating never writes (or is attributed to) a tenant B audit row, and vice versa, under two racing loops', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'fleet-c2-cross-tenant',
    });
    redis = createRedis(resolveRedisUrl());
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const tenantA = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Fleet C2 Tenant A',
      label: 'tenant-a-inst',
    });
    const tenantB = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Fleet C2 Tenant B',
      label: 'tenant-b-inst',
    });

    function makeDeps(workerId: string): DiscoveryDeps {
      return {
        pool,
        redis,
        env: 'test',
        workerId,
        admission: { canAcceptLease: () => ({ ok: true, state: 'accepting' }) },
        grab: async () => false, // never grabs - keeps both rows unowned/contested every cycle
        markInfraUnavailable: async (row) =>
          tenantDbAsWpApp.withTenant(row.clientId, (tx) => markInfraUnavailableIfChanged(tx, row)),
        getLagP99Ms: () => 0,
        getCap: () => 100,
        getCurrentSessions: () => 0,
        staleMs: 1_000,
        maxRows: 500,
        onCycleError: (err) => {
          throw err instanceof Error ? err : new Error(String(err));
        },
      };
    }

    const loopA = createDiscoveryLoop(makeDeps(`c2-worker-a-${randomUUID()}`));
    const loopB = createDiscoveryLoop(makeDeps(`c2-worker-b-${randomUUID()}`));

    // Both loops see BOTH tenants' rows every cycle (a real worker's scan is
    // not tenant-partitioned) and race each other 3 times concurrently -
    // each tenant's row independently crosses the 3-cycle threshold.
    for (let cycle = 0; cycle < 3; cycle++) {
      await Promise.all([loopA.runOneCycle(), loopB.runOneCycle()]);
    }

    const auditA = await pool.query<{ id: string; client_id: string; target_id: string }>(
      `SELECT id, client_id, target_id FROM audit_logs WHERE target_id = $1 AND action = 'instance.degraded'`,
      [tenantA.instanceId],
    );
    const auditB = await pool.query<{ id: string; client_id: string; target_id: string }>(
      `SELECT id, client_id, target_id FROM audit_logs WHERE target_id = $1 AND action = 'instance.degraded'`,
      [tenantB.instanceId],
    );

    // Exactly one audit row per tenant's instance, despite two racing loops.
    expect(auditA.rows.length).toBe(1);
    expect(auditB.rows.length).toBe(1);

    // Each audit row is scoped to its OWN tenant - never cross-attributed.
    expect(auditA.rows[0]?.client_id).toBe(tenantA.clientId);
    expect(auditB.rows[0]?.client_id).toBe(tenantB.clientId);
    expect(auditA.rows[0]?.client_id).not.toBe(tenantB.clientId);
    expect(auditB.rows[0]?.client_id).not.toBe(tenantA.clientId);

    // Cross-check: NO audit row for tenant A's instance carries tenant B's
    // client_id and vice versa (belt-and-suspenders on top of the direct
    // equality checks above, guarding against a query that silently ignored
    // the client_id predicate).
    const crossLeakA = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE target_id = $1 AND client_id = $2`,
      [tenantA.instanceId, tenantB.clientId],
    );
    const crossLeakB = await pool.query<{ id: string }>(
      `SELECT id FROM audit_logs WHERE target_id = $1 AND client_id = $2`,
      [tenantB.instanceId, tenantA.clientId],
    );
    expect(crossLeakA.rows.length).toBe(0);
    expect(crossLeakB.rows.length).toBe(0);

    // Both instances' health state reflects their OWN escalation only.
    const stateA = await pool.query<{ health_state: string; needs_user_action: boolean }>(
      'SELECT health_state, needs_user_action FROM whatsapp_instances WHERE id = $1',
      [tenantA.instanceId],
    );
    const stateB = await pool.query<{ health_state: string; needs_user_action: boolean }>(
      'SELECT health_state, needs_user_action FROM whatsapp_instances WHERE id = $1',
      [tenantB.instanceId],
    );
    expect(stateA.rows[0]).toMatchObject({ health_state: 'degraded', needs_user_action: true });
    expect(stateB.rows[0]).toMatchObject({ health_state: 'degraded', needs_user_action: true });
  }, 30_000);
});

// ---------------------------------------------------------------------
// Case 5 (retry storms / anti-churn), end-to-end real-infra confirmation:
// after a REAL shed (real LeaseManager.release + real endSocket via a
// registry handle) against real Postgres+Redis, the SAME worker's registry
// still reports the instance as held, so its own next discovery cycle skips
// re-grabbing it even though the lease is genuinely free in Postgres/Redis -
// confirming fleet-c2-unit-shed-and-cap.test.ts's adapter-level pin is
// reachable through the real lease machinery, not just a mocked
// LeaseManager.
// ---------------------------------------------------------------------
describe('C2 case 5 (real infra) - shed then same-worker rescan can re-claim the instance', () => {
  it("shed_removes_the_registry_entry_end_to_end_against_real_lease_machinery: a real LeaseManager.release after shed leaves the lease free, and the shedding worker's own registry.has() reports false, so its own grab() callback can re-acquire it", async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'fleet-c2-shed-churn',
    });
    redis = createRedis(resolveRedisUrl());
    const tenantDb = createTenantDb(pool);

    const target = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Fleet C2 Shed Churn',
      label: 'shed-churn',
    });
    const workerId = `c2-shed-worker-${randomUUID()}`;
    const leaseRedis = createLeaseRedis(redis, {
      timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
    });
    const registry = createSessionRegistry();
    const sessionOwner: SessionOwner = {
      onFenceLost: () => undefined,
      close: async (instanceId: string) => {
        const handle = registry.get(instanceId);
        handle?.end();
      },
    };
    const leaseManager = new LeaseManager({
      leaseRedis,
      tenantDb,
      sessionOwner,
      workerId,
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });

    // Real acquire - a genuine lease + fence minted in Postgres, a genuine
    // Redis lease key set.
    const lease = await leaseManager.acquire({
      instanceId: target.instanceId,
      clientId: target.clientId,
    });
    expect(lease).not.toBeNull();

    let socketEnded = false;
    const handle: RunnerHandle = {
      instanceId: target.instanceId,
      clientId: target.clientId,
      end: () => {
        socketEnded = true;
      },
      // C2 FIX: fleet-adapters.ts's shed endSocket now calls
      // teardownNoRelease() (idempotent end + timer cleanup), never the bare
      // end() - this fixture's teardownNoRelease sets the SAME socketEnded
      // flag a real runner's teardownNoRelease() would (it routes through
      // endSocketOnce, which calls the underlying socket's end()).
      teardownNoRelease: async () => {
        socketEnded = true;
      },
      teardownWithRelease: async () => undefined,
    };
    registry.set(target.instanceId, handle);

    // Execute the REAL shed sequence via the REAL adapter this worker's own
    // wiring uses (fleet-adapters.ts's buildShedPortsWithLeaseLookup), over
    // the REAL LeaseManager - this is byte-for-byte what
    // session-worker-composition.ts's fleet runtime would call.
    const ports = buildShedPortsWithLeaseLookup(registry, leaseManager, (id) =>
      id === target.instanceId ? lease! : undefined,
    );
    const results = await shedVictims([target.instanceId], ports);
    expect(results).toEqual([
      { instanceId: target.instanceId, ok: true, endOk: true, releaseOk: true },
    ]);
    expect(socketEnded).toBe(true);

    // Confirm the lease is GENUINELY free in Postgres now (a second, totally
    // independent LeaseManager for a DIFFERENT worker can acquire it
    // immediately - the grace-skip-on-clean-release path).
    const otherWorkerId = `c2-shed-worker-other-${randomUUID()}`;
    const otherLeaseManager = new LeaseManager({
      leaseRedis: createLeaseRedis(createRedisForOther(), {
        timeoutMs: COMPRESSED_TIMING.redisCommandTimeoutMs,
      }),
      tenantDb,
      sessionOwner: { onFenceLost: () => undefined, close: async () => undefined },
      workerId: otherWorkerId,
      env: 'test',
      timing: COMPRESSED_TIMING as unknown as typeof import('@wp/domain').TIMING,
    });
    const otherLease = await otherLeaseManager.acquire({
      instanceId: target.instanceId,
      clientId: target.clientId,
    });
    expect(otherLease).not.toBeNull();
    expect(otherLease?.graceMs).toBe(0); // clean recent release - grace skipped, promptly re-grabbable

    // THE FIX: the ORIGINAL shedding worker's own registry no longer
    // reports this instance as held - it (a) ended its socket via
    // teardownNoRelease, (b) released its lease, (c) deleted its own
    // registry entry, and (d) a DIFFERENT worker has already re-acquired
    // it. session-worker-composition.ts's own `grab` callback uses exactly
    // this predicate to skip re-starting a session:
    //   if (registry.has(row.instanceId)) { return true; }
    // A worker that sheds its own instance and then sees it reappear in its
    // OWN next discovery scan no longer reports "already owned" trivially -
    // it calls startDiscovered() again and can re-acquire it.
    expect(registry.has(target.instanceId)).toBe(false);

    function createRedisForOther(): ReturnType<typeof createRedis> {
      const r = createRedis(resolveRedisUrl());
      redisHandles.push(r);
      return r;
    }
  }, 20_000);
});
