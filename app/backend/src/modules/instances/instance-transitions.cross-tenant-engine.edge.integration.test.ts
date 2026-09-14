import { createPool } from '@wp/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { StateWriteLostFenceError, markLinkedConnected } from './repo.js';
import {
  cleanupProbeClients,
  ctxFor,
  seedLease,
  seedTenant,
  type TestPool,
} from './__tests__/instances-test-helpers.js';

/**
 * instance-transitions.cross-tenant-engine.edge.integration.test.ts - E3
 * edge-case pass (P08 session-qr-linking). The routes-level cross-tenant
 * probe (instance-link.routes.integration.test.ts's
 * `link_and_link_status_are_scoped_to_the_owning_client`) only proves the
 * TENANT-ACTION surface (link/park/online return 404 for a foreign client).
 * This file adds the ENGINE-write half explicitly called out by the
 * dispatch: an engine write carrying tenant B's `clientId` against tenant
 * A's `instanceId`, with a FENCE VALUE that is genuinely valid for A's own
 * lease - the `client_id = $client_id` predicate in every engine statement
 * must reject it purely on tenant mismatch, independent of the fence value
 * being otherwise correct. Zero rows, `StateWriteLostFenceError`, tenant A's
 * row untouched.
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

describe('cross-tenant engine write: client_id predicate rejects even a fence-correct caller', () => {
  it('tenant_b_client_id_with_tenant_a_instance_id_and_a_valid_fence_for_a_still_rejects', async () => {
    const tenantA = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(tenantA.clientId);
    const tenantB = await seedTenant(pool, { healthState: 'connected' });
    probeClientIds.push(tenantB.clientId);

    const workerId = 'worker-cross-tenant-probe';
    const liveFenceForA = 3n;
    await seedLease(pool, {
      clientId: tenantA.clientId,
      instanceId: tenantA.instanceId,
      fence: liveFenceForA,
      workerId,
    });

    // Ctx scoped to tenant B's clientId, but targeting tenant A's
    // instanceId, using the fence value that IS genuinely live for A. The
    // client_id predicate alone must be enough to reject this - the fence
    // being "correct" for a DIFFERENT tenant's lease must never matter.
    const crossTenantCtx = ctxFor(pool, tenantB.clientId);

    await expect(
      markLinkedConnected(crossTenantCtx, {
        instanceId: tenantA.instanceId,
        fence: liveFenceForA,
        workerId,
        ownerJid: 'cross-tenant-attacker@s.whatsapp.net',
        phoneE164: '+15559998888',
      }),
    ).rejects.toThrow(StateWriteLostFenceError);

    // Tenant A's row is completely untouched.
    const rowA = await pool.query<{
      link_state: string;
      health_state: string;
      owner_jid: string | null;
      client_id: string;
    }>(
      'SELECT link_state, health_state, owner_jid, client_id FROM whatsapp_instances WHERE id = $1',
      [tenantA.instanceId],
    );
    expect(rowA.rows[0]).toEqual({
      link_state: 'linked',
      health_state: 'connected',
      owner_jid: null,
      client_id: tenantA.clientId,
    });

    // And tenant B has no row at all for that instance id (it never
    // existed under B - this predicate is a pure tenant-scope guard, not a
    // "not found vs different tenant" distinction the DB needs to make).
    const rowUnderB = await pool.query(
      'SELECT 1 FROM whatsapp_instances WHERE id = $1 AND client_id = $2',
      [tenantA.instanceId, tenantB.clientId],
    );
    expect(rowUnderB.rows).toHaveLength(0);
  });
});
