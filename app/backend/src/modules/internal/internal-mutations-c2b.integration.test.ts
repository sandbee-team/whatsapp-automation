import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import { seedQueuedJob } from '../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  internalTokenHeader,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { attemptClaim } from './__tests__/internal-mutations-support.js';
import type { AuditWriteOverride } from './with-staff-mutation.js';

/**
 * internal-mutations-c2b.integration.test.ts (P28 C2 hardening) - sibling of
 * `internal-mutations-c2.integration.test.ts` (300-line cap split): a
 * pricing-write crash mid-transaction (symmetric with the already-covered
 * wallet-mutation crash case, but for `PUT clients/:id/pricing`'s two-row
 * write), and tenant isolation of a client suspend.
 */

const SECRET = 'internal-mutations-c2b-test-secret-0123456789';
const CIDRS = '0.0.0.0/0';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

let auditWriteOverride: AuditWriteOverride | undefined;

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-mutations-c2b-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: CIDRS,
      publishWake: () => {},
      get auditWrite() {
        return auditWriteOverride;
      },
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

beforeEach(() => {
  auditWriteOverride = undefined;
});

async function seedStaff(role: 'support' | 'ops' | 'superadmin' = 'superadmin'): Promise<string> {
  const id = await seedStaffUser(pool, role);
  probeStaffIds.push(id);
  return id;
}

function postWithKey(
  path: string,
  staffId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'x-wp-internal-token': internalTokenHeader(SECRET, 'POST', path),
      'x-actor': `staff:${staffId}`,
      'idempotency-key': key,
    },
    payload: body,
  });
}

function putWithKey(
  path: string,
  staffId: string,
  key: string,
  body: Record<string, unknown>,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method: 'PUT',
    url: path,
    headers: {
      'x-wp-internal-token': internalTokenHeader(SECRET, 'PUT', path),
      'x-actor': `staff:${staffId}`,
      'idempotency-key': key,
    },
    payload: body,
  });
}

describe('internal-mutations-c2b: pricing crash + tenant isolation', () => {
  it('a_crash_in_the_middle_of_a_pricing_write_leaves_both_client_pricing_and_max_rate_minor_unchanged', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {
      balanceMinor: 50,
      walletState: 'active',
      maxRateMinor: 100,
    });
    const staffId = await seedStaff('superadmin');
    const path = `/internal/v1/clients/${clientId}/pricing`;

    const before = await pool.query<{ override_items: string; max_rate_minor: string }>(
      `SELECT override_items::text AS override_items,
              (SELECT max_rate_minor::text FROM wallet_accounts WHERE client_id = $1) AS max_rate_minor
         FROM client_pricing WHERE client_id = $1`,
      [clientId],
    );
    const beforeRow = before.rows[0];
    expect(beforeRow).toBeDefined();

    // The INSERT runs for real (so `fn` executes and moves the pricing
    // row), then the result UPDATE throws - proving the audit row and the
    // pricing + wallet-rate rewrite share one transaction, symmetric with
    // the wallet-mutation crash case already covered.
    auditWriteOverride = {
      insert: async (db, input) => {
        const result = await db.query<{ id: string }>(
          `INSERT INTO staff_audit_log
             (staff_id, action, client_id, target_kind, target_ref, reason,
              idempotency_key, request_hash, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}')
           RETURNING id`,
          [
            input.staffId,
            input.action,
            input.clientId,
            input.targetKind,
            input.targetRef,
            input.reason,
            input.idempotencyKey,
            input.requestHash,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error('injected insert returned no row');
        return row.id;
      },
      update: async () => {
        throw new Error('injected audit result-write failure (pricing crash probe)');
      },
    };

    const response = await putWithKey(path, staffId, randomUUID(), {
      reason: 'pricing override that must roll back on an audit failure',
      overrideItems: { text: '90' },
    });
    expect(response.statusCode).toBe(500);

    auditWriteOverride = undefined;

    const after = await pool.query<{ override_items: string; max_rate_minor: string }>(
      `SELECT override_items::text AS override_items,
              (SELECT max_rate_minor::text FROM wallet_accounts WHERE client_id = $1) AS max_rate_minor
         FROM client_pricing WHERE client_id = $1`,
      [clientId],
    );
    expect(after.rows[0]).toEqual(beforeRow);
  });

  it('suspending_one_client_never_blocks_another_clients_queued_job_from_being_claimed', async () => {
    const { clientId: clientA } = await seedSendTenant(pool, probeClientIds, {});
    const { clientId: clientB, instanceId: instanceB } = await seedSendTenant(
      pool,
      probeClientIds,
      {},
    );
    const staffId = await seedStaff('superadmin');

    const suspend = await postWithKey(
      `/internal/v1/clients/${clientA}/suspend`,
      staffId,
      randomUUID(),
      { reason: 'tenant isolation probe: suspend client A only' },
    );
    expect(suspend.statusCode).toBe(200);

    // `seedQueuedJob` defaults `priorityRank: 3` (`DEFAULT_BAND_WEIGHTS.NORMAL`,
    // `@wp/domain`) and `claim-jobs.sql` claims by `j.priority_rank = $band` -
    // `band` must match the seeded row's rank, exactly like the sibling
    // `staff_suspend_stops_claiming_and_preserves_every_queued_job` case in
    // `internal-mutations-clients.integration.test.ts` (`band: 3`). `fence: 1`
    // matches `seedSendTenant`'s own default `instance_lease_state.current_fence`.
    await seedQueuedJob(pool, { clientId: clientB, instanceId: instanceB });
    const claimedForB = await attemptClaim(pool, {
      clientId: clientB,
      instanceId: instanceB,
      band: 3,
      fence: 1,
    });
    expect(claimedForB).toBe(1);
  });
});
