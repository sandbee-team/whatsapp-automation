import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import {
  seedSendTenant,
  cleanupSendProbeClients,
} from '../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  makeStaffHeaders,
  seedStaffUser,
} from './__tests__/internal-routes-test-support.js';
import { seedPendingTopup } from './__tests__/internal-mutations-support.js';

/**
 * internal-topups-list.integration.test.ts (C1 review round 2 MINOR fix -
 * `GET /internal/v1/topups`'s `createdAt` field) - asserts the list route
 * projects the SEEDED row's own `created_at`, never a fabricated
 * `new Date().toISOString()` at response time (the bug this file exists to
 * catch: the two values are indistinguishable in a fast test unless the
 * fixture pins `created_at` to a value clearly in the past).
 */

const SECRET = 'internal-topups-list-test-secret-0123456789';

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let app: FastifyInstance;

const probeClientIds: string[] = [];
const probeStaffIds: string[] = [];

const staffHeaders = makeStaffHeaders(SECRET);

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-topups-list-tests',
  });
  tenantDb = createTenantDb(pool);
  app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: SECRET,
      allowedCidrs: '0.0.0.0/0',
      publishWake: () => {},
    },
  });
});

afterAll(async () => {
  await app.close();
  await cleanupStaffUsers(pool, probeStaffIds);
  await cleanupSendProbeClients(pool, probeClientIds);
  await pool.end();
});

describe('internal-topups-list', () => {
  it('the_list_route_projects_the_seeded_rows_own_created_at', async () => {
    const { clientId } = await seedSendTenant(pool, probeClientIds, {});
    const staffId = await seedStaffUser(pool, 'superadmin');
    probeStaffIds.push(staffId);

    const topupId = await seedPendingTopup(pool, clientId, 12_000);
    // Pin `created_at` to a value clearly distinct from "now" - if the route
    // ever fabricates the timestamp at response time instead of projecting
    // the row's own column, this assertion catches it deterministically
    // (never a flaky near-now comparison).
    const pinnedCreatedAt = new Date('2024-01-15T09:30:00.000Z');
    await pool.query(`UPDATE topup_requests SET created_at = $2 WHERE id = $1`, [
      topupId,
      pinnedCreatedAt,
    ]);

    // The service-token signature binds the path with the query string
    // STRIPPED (`internal-access.ts#assertInternalAccess`'s own doc) - the
    // header must be signed over the bare path, never the full URL.
    const path = '/internal/v1/topups';
    const response = await app.inject({
      method: 'GET',
      url: `${path}?status=pending`,
      headers: staffHeaders('GET', path, staffId),
    });
    expect(response.statusCode).toBe(200);

    const item = (
      response.json() as { data: { items: Array<{ id: string; createdAt: string }> } }
    ).data.items.find((row) => row.id === topupId);
    expect(item).toBeDefined();
    expect(item?.createdAt).toBe(pinnedCreatedAt.toISOString());
  });
});
