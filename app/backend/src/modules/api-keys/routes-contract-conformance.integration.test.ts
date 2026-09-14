import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeysContract } from '@wp/contracts';
import { resolveDatabaseUrl } from '../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl } from '../../platform/redis.js';
import { buildApiKeysApp, buildTestConfig } from './api-keys-routes-test-support.js';

/**
 * routes-contract-conformance.integration.test.ts (go-live 2026-09-14) - split
 * from `routes.integration.test.ts` for the 300-line cap (the established
 * sibling-split idiom).
 *
 * Why it exists: the panel builds every call from `@wp/contracts`, so a route
 * served at a different method/path than its contract declares is a 404 for
 * real users that NO handler test can see - each handler test hits whatever
 * path it was written against. This shipped twice in one day: the admin
 * plan-change button sent POST to a PUT-only proxy, and this module's revoke
 * route was served as `POST /v1/api-keys/:id/revoke` while the contract (and
 * the panel) said `DELETE /v1/api-keys/{id}`. This case walks the contract
 * itself, so the two can never drift apart silently again.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'api-keys-contract-conformance-test',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());
  app = await buildApiKeysApp({
    pool,
    tenantDb,
    redis,
    config: buildTestConfig(),
    sentVerificationUrls: new Map<string, string>(),
  });
});

afterAll(async () => {
  await app.close();
  redis.disconnect();
  await pool.end();
});

describe('api-keys routes match their contract', () => {
  it('every_route_is_served_at_the_method_and_path_its_contract_declares', async () => {
    const declared = Object.values(apiKeysContract).map((contract) => {
      const route = (contract as { '~orpc': { route: { method: string; path: string } } })['~orpc']
        .route;
      return { method: route.method, path: route.path };
    });
    expect(declared.length).toBe(3);

    const registered = app.printRoutes({ commonPrefix: false }).split('\n').join(' ');

    for (const { method, path } of declared) {
      // `{id}` in a contract path is `:id` in Fastify's own route table.
      const fastifyPath = path.replace(/\{(\w+)\}/g, ':$1');
      const response = await app.inject({
        method: method as 'GET' | 'POST' | 'DELETE',
        url: fastifyPath.replace(':id', randomUUID()),
      });
      // No auth header: the route must answer 401 (it exists and is guarded),
      // never 404 (it is not served at this method+path at all).
      expect(response.statusCode, `${method} ${fastifyPath} -> ${registered}`).toBe(401);
    }
  });
});
