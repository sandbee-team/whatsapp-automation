import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPool } from '@wp/db';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createTenantDbAsRole } from '../../platform/db/test-support/wp-app-role.js';
import {
  cleanupProbeClients,
  ctxFor,
} from '../../modules/instances/__tests__/instances-test-helpers.js';
import { beginPairingIntent, setDesiredState } from '../../modules/instances/index.js';
import { readSweepTeardownStatuses } from '../../modules/instances/instance-reads.repo.js';

/**
 * session-worker-sweep.wp-app-role.integration.test.ts (P08 FIX ROUND 2 FIX
 * 1, the test the reviewer prescribed) - `readSweepTeardownStatuses` run
 * through `tenantDb.withTenant` under a REAL `SET LOCAL ROLE wp_app`
 * (non-BYPASSRLS), mirroring
 * `modules/instances/instance-transitions.wp-app-role.integration.test.ts`'s
 * / `provider/baileys/auth-state/wp-app-role.integration.test.ts`'s harness
 * pattern (`createTenantDbAsRole`, the `TenantDb`-shaped sibling of
 * `engine/lease/test-support/worker-as-role.ts`'s `createWorkerDbAsRole`).
 *
 * Regression proof for the bug: the earlier (pre-fix) version of
 * `readSweepTeardownStatuses` ran a BARE, unscoped read (no `client_id`
 * predicate, no role/GUC setup) - under `wp_app`'s FORCE RLS, that silently
 * returned ZERO rows for every client, which `sweepTeardowns` misread as
 * "every held session is ineligible" and tore down. This test seeds TWO
 * tenants, each with one held instance: the client-scoped, role-correct read
 * must return BOTH rows (one query per client), a healthy held session must
 * SURVIVE, and a genuinely-parked one must still be torn down.
 */

let pool: ReturnType<typeof createPool>;
let probeClientIds: string[] = [];

afterEach(async () => {
  await cleanupProbeClients(pool, probeClientIds);
  probeClientIds = [];
});

afterAll(async () => {
  await pool?.end();
});

describe('readSweepTeardownStatuses under the real wp_app role, across two tenants', () => {
  it('both_tenants_rows_come_back_a_healthy_session_survives_and_a_parked_one_is_eligible', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-sweep-wp-app-role-test',
    });
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const clientIdHeld = randomUUID();
    const clientIdParked = randomUUID();
    const instanceIdHeld = randomUUID();
    const instanceIdParked = randomUUID();

    for (const [clientId, instanceId] of [
      [clientIdHeld, instanceIdHeld],
      [clientIdParked, instanceIdParked],
    ] as const) {
      await pool.query(
        `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
        [clientId, 'Sweep WP App Role Probe', `sw-sweep-wp-app-role-probe-${clientId}`],
      );
      await pool.query(
        `INSERT INTO whatsapp_instances
           (id, client_id, label, health_state, link_state, desired_state, session_epoch)
         VALUES ($1, $2, 'probe', 'never_linked', 'unlinked', 'online', 0)`,
        [instanceId, clientId],
      );
      probeClientIds.push(clientId);
      const ctx = ctxFor(pool, clientId);
      await beginPairingIntent(ctx, instanceId);
    }

    // Park ONE of the two via the normal soft path - the OTHER stays online.
    await setDesiredState(ctxFor(pool, clientIdParked), instanceIdParked, 'offline');

    // Each client's read runs in ITS OWN `tenantDb.withTenant` call under
    // wp_app - exactly what `sweepTeardowns` does per client-with-held-
    // sessions.
    const heldStatuses = await tenantDbAsWpApp.withTenant(clientIdHeld, (tx) =>
      readSweepTeardownStatuses({ clientId: clientIdHeld, sql: tx }, [instanceIdHeld]),
    );
    const parkedStatuses = await tenantDbAsWpApp.withTenant(clientIdParked, (tx) =>
      readSweepTeardownStatuses({ clientId: clientIdParked, sql: tx }, [instanceIdParked]),
    );

    // Both tenants' rows come back (not silently zero, the pre-fix bug).
    expect(heldStatuses).toHaveLength(1);
    expect(parkedStatuses).toHaveLength(1);

    const heldStatus = heldStatuses[0]!;
    const parkedStatus = parkedStatuses[0]!;

    // The healthy held session's row proves it is STILL eligible (survives
    // a sweep tick) - never torn down.
    expect(heldStatus.instanceId).toBe(instanceIdHeld);
    expect(heldStatus.desiredState).toBe('online');
    expect(heldStatus.deletedAt).toBeNull();

    // The genuinely-parked instance's row proves it is INeligible (its
    // desired_state is no longer 'online') - the caller tears it down.
    expect(parkedStatus.instanceId).toBe(instanceIdParked);
    expect(parkedStatus.desiredState).toBe('offline');
  });

  it('a_client_scoped_read_never_returns_another_tenants_instance_row', async () => {
    pool = createPool({
      connectionString: resolveDatabaseUrl(),
      applicationName: 'sw-sweep-wp-app-role-test',
    });
    const tenantDbAsWpApp = createTenantDbAsRole(pool, 'wp_app');

    const clientIdA = randomUUID();
    const clientIdB = randomUUID();
    const instanceIdA = randomUUID();
    const instanceIdB = randomUUID();

    for (const [clientId, instanceId] of [
      [clientIdA, instanceIdA],
      [clientIdB, instanceIdB],
    ] as const) {
      await pool.query(
        `INSERT INTO clients (id, company_name, slug, status) VALUES ($1, $2, $3, 'active')`,
        [clientId, 'Sweep WP App Role Isolation Probe', `sw-sweep-wp-app-role-iso-${clientId}`],
      );
      await pool.query(
        `INSERT INTO whatsapp_instances
           (id, client_id, label, health_state, link_state, desired_state, session_epoch)
         VALUES ($1, $2, 'probe', 'never_linked', 'unlinked', 'online', 0)`,
        [instanceId, clientId],
      );
      probeClientIds.push(clientId);
      const ctx = ctxFor(pool, clientId);
      await beginPairingIntent(ctx, instanceId);
    }

    // Ask for BOTH instance ids while scoped to client A only - client B's
    // row must never come back, even though the id list includes it.
    const statuses = await tenantDbAsWpApp.withTenant(clientIdA, (tx) =>
      readSweepTeardownStatuses({ clientId: clientIdA, sql: tx }, [instanceIdA, instanceIdB]),
    );

    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.instanceId).toBe(instanceIdA);
  });
});
