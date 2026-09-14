import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import type { FastifyInstance } from 'fastify';
import type { StaffRole } from '@wp/domain';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { cleanupSendProbeClients } from '../../../engine/queue/__tests__/queue-send-tenant-fixture.js';
import {
  buildInternalApp,
  cleanupStaffUsers,
  internalTokenHeader,
  makeStaffHeaders,
  seedStaffUser,
} from './internal-routes-test-support.js';
import { cleanupU3bRows } from './internal-u3b-support.js';

/**
 * internal-u3b-app-fixture.ts (P28 Unit U3b, step 5) - the boot/teardown +
 * request-helper harness every U3b mutation test file shares
 * (`internal-mutations-{clients,clients-pricing,instances,pacing,campaigns}
 * .integration.test.ts`).
 *
 * Extracted because five test files each needed the identical ~70 lines of
 * `beforeAll`/`afterAll`/`post`/`seedStaff` boilerplate, which pushed two of
 * them past the `max-lines: 300` cap - and because a divergent copy would let
 * one file's cleanup miss a table another file's assertions depend on being
 * empty. NOT itself a test file.
 *
 * Each file passes its OWN `secret` (so a service token signed for one file's
 * app is worthless against another's) and its own `publishWake` sink.
 */

export interface U3bHarness {
  pool: ReturnType<typeof createPool>;
  tenantDb: TenantDb;
  app: FastifyInstance;
  probeClientIds: string[];
  probeStaffIds: string[];
  /** Every `(clientId, instanceId)` pair the routes published a wake for, in order. */
  wakeCalls: Array<{ clientId: string; instanceId: string }>;
  seedStaff: (role: StaffRole) => Promise<string>;
  send: (
    method: 'POST' | 'PUT',
    path: string,
    staffId: string,
    body: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  /** Same signed token and idempotency key, but an arbitrary `x-actor` - the safety-boundary 11 non-staff-actor probe. */
  sendAs: (
    method: 'POST' | 'PUT',
    path: string,
    actor: string,
    body: Record<string, unknown>,
  ) => Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  close: () => Promise<void>;
}

export interface StartU3bHarnessOptions {
  secret: string;
  applicationName: string;
}

/** Boots the REAL app with `/internal/v1` wired, and returns the harness (see module doc). Call `close()` in `afterAll`. */
export async function startU3bHarness(options: StartU3bHarnessOptions): Promise<U3bHarness> {
  const pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: options.applicationName,
  });
  const tenantDb = createTenantDb(pool);
  const probeClientIds: string[] = [];
  const probeStaffIds: string[] = [];
  const wakeCalls: Array<{ clientId: string; instanceId: string }> = [];

  const app = await buildInternalApp({
    pool,
    tenantDb,
    internal: {
      pool,
      tenantDb,
      serviceTokenSecret: options.secret,
      allowedCidrs: '0.0.0.0/0',
      publishWake: (clientId, instanceId) => {
        wakeCalls.push({ clientId, instanceId });
      },
    },
  });

  const staffHeaders = makeStaffHeaders(options.secret);

  return {
    pool,
    tenantDb,
    app,
    probeClientIds,
    probeStaffIds,
    wakeCalls,
    seedStaff: async (role) => {
      const id = await seedStaffUser(pool, role);
      probeStaffIds.push(id);
      return id;
    },
    send: (method, path, staffId, body) =>
      app.inject({
        method,
        url: path,
        headers: staffHeaders(method, path, staffId),
        payload: body,
      }),
    sendAs: (method, path, actor, body) =>
      app.inject({
        method,
        url: path,
        headers: {
          'x-wp-internal-token': internalTokenHeader(options.secret, method, path),
          'x-actor': actor,
          'idempotency-key': crypto.randomUUID(),
        },
        payload: body,
      }),
    close: async () => {
      await app.close();
      await cleanupStaffUsers(pool, probeStaffIds);
      await cleanupU3bRows(pool, probeClientIds);
      await cleanupSendProbeClients(pool, probeClientIds);
      await pool.end();
    },
  };
}
