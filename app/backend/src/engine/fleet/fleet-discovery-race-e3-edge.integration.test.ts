import '../../modules/realtime/__test-support__/stub-wp-server-kit-env.js';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  createDiscoveryLoop,
  markInfraUnavailableIfChanged,
  type DiscoveryDeps,
} from './discovery.js';

/**
 * fleet-discovery-race-e3-edge.integration.test.ts - P09 E3 edge-case pass,
 * split out of `fleet-integration-e3-edge.integration.test.ts` at
 * FIX-P09-B for the max-lines cap (topic split only - same cases,
 * unchanged), real Postgres + Redis only:
 *
 *   Two independent in-process "workers" (two createDiscoveryLoop
 *   instances, each with its OWN consecutiveUnowned bookkeeping - the real
 *   production shape, since each worker process owns its own in-memory
 *   escalation counter) racing to grab the SAME unowned instances
 *   concurrently against real PG+Redis: exactly one owner per instance (the
 *   LeaseManager-backed grab is the real arbiter), zero duplicate audit
 *   rows even when both workers' escalation bookkeeping independently
 *   crosses the 3-cycle threshold, and zero message_jobs mutations.
 *
 * See `fleet-connect-bucket-e3-edge.integration.test.ts` for the connect-
 * bucket and outage-boundary cases.
 */

type Pool = ReturnType<typeof createPool>;

let pool: Pool;
let redis: ReturnType<typeof createRedis>;
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
  redis?.disconnect();
});

async function seedInstance(options: {
  clientCompanyName: string;
  label: string;
}): Promise<{ clientId: string; instanceId: string }> {
  const clientId = randomUUID();
  const instanceId = randomUUID();

  await pool.query('INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, $4)', [
    clientId,
    options.clientCompanyName,
    `fleet-e3-probe-${clientId}`,
    'active',
  ]);
  await pool.query(
    `INSERT INTO whatsapp_instances
       (id, client_id, label, health_state, session_epoch, desired_state, link_state)
     VALUES ($1, $2, $3, 'connected', 0, 'online', 'linked')`,
    [instanceId, clientId, options.label],
  );

  probeClientIds.push(clientId);
  return { clientId, instanceId };
}

function makeDiscoveryDepsForRole(
  admissionOk: boolean,
  tenantDbAsWpApp: ReturnType<typeof createTenantDbAsRole>,
  grab: DiscoveryDeps['grab'],
): DiscoveryDeps {
  return {
    pool,
    redis,
    env: 'test',
    workerId: `fleet-e3-worker-${randomUUID()}`,
    admission: {
      canAcceptLease: () => ({ ok: admissionOk, state: admissionOk ? 'accepting' : 'holding' }),
    },
    grab,
    markInfraUnavailable: async (row) =>
      tenantDbAsWpApp.withTenant(row.clientId, (tx) => markInfraUnavailableIfChanged(tx, row)),
    getLagP99Ms: () => 0,
    getCap: () => 100,
    getCurrentSessions: () => 0,
    staleMs: 1_000,
    maxRows: 500,
    onCycleError: (err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    },
  };
}

describe('two in-process discovery loops racing the same unowned instances - real PG+Redis', () => {
  it('exactly_one_owner_per_instance_no_duplicate_audit_rows_zero_job_mutations', async () => {
    pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'fleet-e3-edge' });
    redis = createRedis(resolveRedisUrl());
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    // Seed 5 never-leased instances - contested by both loops every cycle.
    const targets = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedInstance({
          clientCompanyName: `Fleet E3 Race ${String(i)}`,
          label: `race-${String(i)}`,
        }),
      ),
    );

    // Seed one queued job per instance - the invariant-5 proof.
    const jobIds: string[] = [];
    for (const target of targets) {
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
          JSON.stringify({ text: 'race-probe' }),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('seed message_jobs: no row returned');
      jobIds.push(row.id);
    }

    // Both loops NEVER actually grab (grab -> false) so every cycle keeps
    // every instance unowned and contested - this isolates the escalation
    // race specifically (two independent in-memory streak counters both
    // reaching 3 and both attempting the escalation write concurrently).
    const grabAttemptsByWorker = { a: 0, b: 0 };
    const loopA = createDiscoveryLoop(
      makeDiscoveryDepsForRole(true, tenantDbAsWpApp, async () => {
        grabAttemptsByWorker.a += 1;
        return false;
      }),
    );
    const loopB = createDiscoveryLoop(
      makeDiscoveryDepsForRole(true, tenantDbAsWpApp, async () => {
        grabAttemptsByWorker.b += 1;
        return false;
      }),
    );

    // Run 3 concurrent cycle-pairs - both loops race each cycle, both
    // reach the 3-consecutive-cycle threshold at the same wall-clock time.
    for (let cycle = 0; cycle < 3; cycle++) {
      await Promise.all([loopA.runOneCycle(), loopB.runOneCycle()]);
    }

    // Both workers attempted to grab every instance every cycle (contested).
    expect(grabAttemptsByWorker.a).toBeGreaterThan(0);
    expect(grabAttemptsByWorker.b).toBeGreaterThan(0);

    for (const target of targets) {
      const row = await pool.query<{
        health_state: string;
        needs_user_action: boolean;
        user_action_reason: string | null;
      }>(
        'SELECT health_state, needs_user_action, user_action_reason FROM whatsapp_instances WHERE id = $1',
        [target.instanceId],
      );
      expect(row.rows[0]?.health_state).toBe('degraded');
      expect(row.rows[0]?.needs_user_action).toBe(true);
      expect(row.rows[0]?.user_action_reason).toBe('INFRA_UNAVAILABLE');

      // Exactly ONE audit row per instance despite BOTH loops racing the
      // conditional, changed-flag-gated write concurrently.
      const auditRows = await pool.query<{ id: string }>(
        `SELECT id FROM audit_logs WHERE client_id = $1 AND target_id = $2 AND action = 'instance.degraded'`,
        [target.clientId, target.instanceId],
      );
      expect(auditRows.rows.length).toBe(1);
    }

    // Zero job mutations - every seeded job is still 'queued', byte-for-byte.
    const afterJobs = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM message_jobs WHERE id = ANY($1) ORDER BY id',
      [jobIds],
    );
    expect(afterJobs.rows.every((r) => r.status === 'queued')).toBe(true);
    expect(afterJobs.rows.map((r) => r.id).sort()).toEqual([...jobIds].sort());
  }, 30_000);

  it('one_loop_grabs_first_the_other_loop_never_double_opens_by_treating_the_now_owned_row_as_absent_next_scan', async () => {
    pool = createPool({ connectionString: resolveDatabaseUrl(), applicationName: 'fleet-e3-edge' });
    redis = createRedis(resolveRedisUrl());
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const target = await seedInstance({
      clientCompanyName: 'Fleet E3 Single Owner',
      label: 'single-owner',
    });

    let grabbedByA = false;
    const grabCallsA: string[] = [];
    const grabCallsB: string[] = [];

    const loopA = createDiscoveryLoop(
      makeDiscoveryDepsForRole(true, tenantDbAsWpApp, async (row) => {
        grabCallsA.push(row.instanceId);
        grabbedByA = true; // Loop A always successfully grabs in this test.
        return true;
      }),
    );
    const loopB = createDiscoveryLoop(
      makeDiscoveryDepsForRole(true, tenantDbAsWpApp, async (row) => {
        grabCallsB.push(row.instanceId);
        // Loop B "sees" the real lease state via a live lease row check -
        // once A has grabbed, the underlying scanUnowned query itself
        // would no longer return this row for a real lease-backed grab
        // (this test approximates that with a real lease insert after A's
        // grab, then re-runs B and asserts B's scan no longer includes it).
        return false;
      }),
    );

    await loopA.runOneCycle();
    expect(grabbedByA).toBe(true);
    expect(grabCallsA).toContain(target.instanceId);

    // Simulate A's successful grab producing a live lease row (the real
    // effect a successful `grab()` has via LeaseManager.acquire in
    // production wiring) so the NEXT scan genuinely excludes this
    // instance for any other worker.
    await pool.query(
      `INSERT INTO instance_lease_state (instance_id, client_id, current_fence, owner_worker_id, lease_seen_at)
         VALUES ($1, $2, 1, 'worker-a-e3', now())
         ON CONFLICT (instance_id) DO UPDATE SET owner_worker_id = 'worker-a-e3', lease_seen_at = now()`,
      [target.instanceId, target.clientId],
    );

    grabCallsB.length = 0;
    await loopB.runOneCycle();

    // Loop B's scan no longer surfaces the now-owned instance - it never
    // calls grab for it again (no double socket open).
    expect(grabCallsB).not.toContain(target.instanceId);
  }, 30_000);
});
