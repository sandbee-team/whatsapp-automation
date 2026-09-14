import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import { createDiscoveryLoop, markInfraUnavailableIfChanged } from './discovery.js';
import {
  type Pool,
  cleanupProbeClients,
  seedInstance,
  makeDiscoveryDeps,
} from './__tests__/discovery-integration-test-support.js';

/**
 * discovery-escalation.integration.test.ts (P09 Unit U3 step 5, FIX-P09-B
 * split) - the 3-cycle escalation and two-tenant isolation cases, split out
 * of `discovery.integration.test.ts` at FIX-P09-B for the max-lines cap
 * (topic split only - same cases, unchanged). Real Postgres + Redis proofs -
 * see `discovery-lease.integration.test.ts` for the live-lease exclusion
 * case and `discovery-integration-test-support.ts` for the shared
 * seed/cleanup/makeDeps helpers. The escalation write
 * (`markInfraUnavailableIfChanged`) is proved under the REAL `wp_app` role
 * via `createTenantDbAsRole` (the P08 FIX ROUND 2 pattern) since that write
 * is client-scoped and RLS-governed.
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
  it('unowned_instance_becomes_degraded_with_infra_unavailable_after_three_cycles', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'discovery-test',
    });
    redis = createRedis(resolveRedisUrl());
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const target = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Discovery Probe Escalation',
      label: 'never-leased',
    });

    // Seed 3 queued message_jobs rows - the invariant-5 proof: escalation
    // must touch ZERO of them.
    const jobIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO message_jobs
             (client_id, instance_id, session_epoch, recipient_jid, recipient_e164,
              payload, payload_kind, priority, priority_rank, status, scheduled_at, next_attempt_at)
           VALUES ($1, $2, 0, $3, '+15550000000', $4, 'text', 'normal', 10, 'queued', now(), now())
           RETURNING id`,
        [
          target.clientId,
          target.instanceId,
          `${randomUUID().replaceAll('-', '')}@s.whatsapp.net`,
          JSON.stringify({ text: 'hello' }),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('seed message_jobs: no row returned');
      jobIds.push(row.id);
    }

    const beforeJobs = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM message_jobs WHERE instance_id = $1 ORDER BY id',
      [target.instanceId],
    );

    const deps = makeDiscoveryDeps(pool, redis, {
      grab: async () => false, // never grabbed - stays unowned every cycle.
      markInfraUnavailable: async (row) =>
        tenantDbAsWpApp.withTenant(row.clientId, (tx) => markInfraUnavailableIfChanged(tx, row)),
    });
    const loop = createDiscoveryLoop(deps);

    // Cycles 1 and 2: below the 3-consecutive-cycle threshold - no
    // escalation yet.
    await loop.runOneCycle();
    let row = await pool.query<{ health_state: string; needs_user_action: boolean }>(
      'SELECT health_state, needs_user_action FROM whatsapp_instances WHERE id = $1',
      [target.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('connected');

    await loop.runOneCycle();
    row = await pool.query(
      'SELECT health_state, needs_user_action FROM whatsapp_instances WHERE id = $1',
      [target.instanceId],
    );
    expect(row.rows[0]?.health_state).toBe('connected');

    // Cycle 3: escalation fires.
    await loop.runOneCycle();

    const escalated = await pool.query<{
      health_state: string;
      needs_user_action: boolean;
      user_action_reason: string | null;
    }>(
      'SELECT health_state, needs_user_action, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [target.instanceId],
    );
    expect(escalated.rows[0]?.health_state).toBe('degraded');
    expect(escalated.rows[0]?.needs_user_action).toBe(true);
    expect(escalated.rows[0]?.user_action_reason).toBe('INFRA_UNAVAILABLE');

    const auditRows = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'instance.degraded'`,
      [target.clientId, target.instanceId],
    );
    expect(auditRows.rows.length).toBe(1);

    // P17 U6 (step 5) - exactly ONE `infra_unavailable` notification for
    // this escalation.
    const notificationRows = await pool.query<{ kind: string; requires_user_action: boolean }>(
      `SELECT kind, requires_user_action FROM notifications WHERE client_id = $1 AND instance_id = $2`,
      [target.clientId, target.instanceId],
    );
    expect(notificationRows.rows).toHaveLength(1);
    expect(notificationRows.rows[0]?.kind).toBe('infra_unavailable');
    expect(notificationRows.rows[0]?.requires_user_action).toBe(true);

    // Zero jobs failed/deleted/modified - byte-identical count + status.
    const afterJobs = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM message_jobs WHERE instance_id = $1 ORDER BY id',
      [target.instanceId],
    );
    expect(afterJobs.rows.length).toBe(beforeJobs.rows.length);
    expect(afterJobs.rows).toEqual(beforeJobs.rows);
    expect(afterJobs.rows.map((r) => r.id).sort()).toEqual([...jobIds].sort());

    // A 4th cycle after the escalation already landed is a no-op (zero-
    // effect idempotent write) - no second audit row.
    await loop.runOneCycle();
    const auditRowsAfter = await pool.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'instance.degraded'`,
      [target.clientId, target.instanceId],
    );
    expect(auditRowsAfter.rows.length).toBe(1);

    const notificationRowsAfter = await pool.query<{ kind: string }>(
      `SELECT kind FROM notifications WHERE client_id = $1 AND instance_id = $2`,
      [target.clientId, target.instanceId],
    );
    expect(notificationRowsAfter.rows).toHaveLength(1);
  }, 30_000);

  it('two_tenants_instances_do_not_interfere_in_one_scan', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'discovery-test',
    });
    redis = createRedis(resolveRedisUrl());
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const tenantA = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Discovery Probe Tenant A',
      label: 'a-never-leased',
    });
    const tenantB = await seedInstance(pool, probeClientIds, {
      clientCompanyName: 'Discovery Probe Tenant B',
      label: 'b-never-leased',
    });

    const grabbedByClient = new Map<string, string[]>();
    const deps = makeDiscoveryDeps(pool, redis, {
      grab: async (row) => {
        const list = grabbedByClient.get(row.clientId) ?? [];
        list.push(row.instanceId);
        grabbedByClient.set(row.clientId, list);
        return false; // never grabbed - drives 3-cycle escalation for both.
      },
      markInfraUnavailable: async (row) =>
        tenantDbAsWpApp.withTenant(row.clientId, (tx) => markInfraUnavailableIfChanged(tx, row)),
    });
    const loop = createDiscoveryLoop(deps);

    await loop.runOneCycle();
    await loop.runOneCycle();
    await loop.runOneCycle();

    // Both tenants' instances were seen and escalated independently - tenant
    // A's grab attempts never appear under tenant B's bucket and vice versa.
    expect(grabbedByClient.get(tenantA.clientId)).toContain(tenantA.instanceId);
    expect(grabbedByClient.get(tenantB.clientId)).toContain(tenantB.instanceId);
    expect(grabbedByClient.get(tenantA.clientId)).not.toContain(tenantB.instanceId);
    expect(grabbedByClient.get(tenantB.clientId)).not.toContain(tenantA.instanceId);

    const stateA = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [tenantA.instanceId],
    );
    const stateB = await pool.query<{ health_state: string; user_action_reason: string | null }>(
      'SELECT health_state, user_action_reason FROM whatsapp_instances WHERE id = $1',
      [tenantB.instanceId],
    );
    expect(stateA.rows[0]?.health_state).toBe('degraded');
    expect(stateA.rows[0]?.user_action_reason).toBe('INFRA_UNAVAILABLE');
    expect(stateB.rows[0]?.health_state).toBe('degraded');
    expect(stateB.rows[0]?.user_action_reason).toBe('INFRA_UNAVAILABLE');

    // Tenant A's audit row carries only tenant A's client_id, never tenant B's.
    const auditA = await pool.query<{ client_id: string }>(
      `SELECT client_id FROM audit_logs WHERE target_id = $1 AND action = 'instance.degraded'`,
      [tenantA.instanceId],
    );
    expect(auditA.rows.every((r) => r.client_id === tenantA.clientId)).toBe(true);
  }, 30_000);
});
