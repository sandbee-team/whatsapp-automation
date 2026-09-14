import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { buildInternalApp } from './__tests__/internal-routes-test-support.js';

/**
 * internal-mount-absence.integration.test.ts (P28 Unit U3a, step 4) - the
 * `internal_routes_are_absent_when_the_flag_is_off` case, split out of
 * `internal-auth.integration.test.ts` for that file's `max-lines: 300` cap
 * (the established sibling-split idiom). It is the natural split point: this
 * is the ONLY gate case that seeds no tenant, no staff row and no money, so
 * it shares none of the other file's fixture.
 *
 * ABSENT, not merely forbidden: with `internal: undefined` (what
 * `roles/api.ts` passes when `INTERNAL_API_ENABLED` is off) `buildApp` never
 * registers the module, so every mount path 404s rather than 403s - an
 * attacker cannot even confirm the surface exists in a deployment that has
 * it disabled.
 *
 * `.integration.test.ts` suffix is mandatory (real Postgres pool) - see
 * `internal-auth.integration.test.ts`'s header.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let appWithInternal: FastifyInstance;
let appWithoutInternal: FastifyInstance;

const SECRET = 'internal-mount-absence-secret-0123456789';

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'internal-mount-absence-tests',
  });
  tenantDb = createTenantDb(pool);
  appWithInternal = await buildInternalApp({
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
  appWithoutInternal = await buildInternalApp({ pool, tenantDb, internal: undefined });
});

afterAll(async () => {
  await appWithInternal.close();
  await appWithoutInternal.close();
  await pool.end();
});

describe('internal-mount-absence', () => {
  it('internal_routes_are_absent_when_the_flag_is_off', async () => {
    const clientId = randomUUID();
    const id = randomUUID();
    const mountPaths: Array<{ method: 'POST' | 'GET'; url: string }> = [
      { method: 'POST', url: `/internal/v1/clients/${clientId}/wallet/credit` },
      { method: 'POST', url: `/internal/v1/clients/${clientId}/wallet/adjust` },
      { method: 'POST', url: `/internal/v1/clients/${clientId}/wallet/freeze` },
      { method: 'POST', url: `/internal/v1/clients/${clientId}/wallet/unfreeze` },
      { method: 'POST', url: `/internal/v1/topups/${id}/approve` },
      { method: 'POST', url: `/internal/v1/topups/${id}/reject` },
      { method: 'GET', url: '/internal/v1/topups?status=pending' },
      { method: 'GET', url: '/internal/v1/plans' },
      { method: 'GET', url: '/internal/v1/ui/topups' },
    ];

    for (const route of mountPaths) {
      const response = await appWithoutInternal.inject({ method: route.method, url: route.url });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404);
    }

    // The P19 staff HTML page is GONE, not flag-gated: `/internal/v1/ui/topups`
    // 404s even with `internal` fully wired, and the module file itself is
    // deleted (so no future edit can silently re-register it).
    const uiWhenWired = await appWithInternal.inject({
      method: 'GET',
      url: '/internal/v1/ui/topups',
    });
    expect(uiWhenWired.statusCode).toBe(404);

    const uiModulePath = fileURLToPath(new URL('./ui/topups-page.ts', import.meta.url));
    expect(existsSync(uiModulePath)).toBe(false);
  });
});
