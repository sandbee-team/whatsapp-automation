import type { FastifyInstance } from 'fastify';
import { createPool, createTenantDb, type TenantDb } from '@wp/db';
import { authContract, authPasswordContract } from '@wp/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveDatabaseUrl } from '../../../platform/db/db-url.js';
import { createRedis, resolveRedisUrl, sysKey } from '../../../platform/redis.js';
import type { Config } from '../../../platform/config.js';
import {
  buildIdentityApp,
  buildTestConfig,
  cleanupCreatedIdentityRecords,
  STRONG_PASSWORD,
  uniqueEmail,
  uniqueIp,
} from './identity-routes-test-support.js';

/**
 * identity-routes-hardening.integration.test.ts (P04a Unit UA6; split P04a
 * FIXD from identity-routes.integration.test.ts for max-lines) - the
 * structural "every implemented route exists in the contract" check, the
 * FIX 9 (trust-proxy default) test, and the FIX 12 (rate-limit key PII)
 * test. The core auth HTTP flow lives in
 * identity-routes-auth.integration.test.ts. Pure move: no test case
 * dropped, weakened or merged, no assertion changed.
 */

let pool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let redis: ReturnType<typeof createRedis>;
let app: FastifyInstance;
let config: Config;
// FIX 9 (P04a FIXB): a SECOND app built with TRUST_PROXY at its default
// (false) - proves the header-spoofing behavior the main `app` above
// deliberately opts out of via its own config override.
let appDefaultTrustProxy: FastifyInstance;
const registeredRoutes: { method: string; path: string }[] = [];

const createdUserIds: string[] = [];
const createdClientIds: string[] = [];

beforeAll(async () => {
  pool = createPool({
    connectionString: resolveDatabaseUrl(),
    applicationName: 'app-backend-tests',
  });
  tenantDb = createTenantDb(pool);
  redis = createRedis(resolveRedisUrl());

  config = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '3',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '3',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    // Many distinct IPs needed (test isolation via `uniqueIp()`), so
    // TRUST_PROXY is explicitly enabled here, config-driven and honest.
    TRUST_PROXY: 'true',
  });
  app = await buildIdentityApp(
    { pool, tenantDb, redis, config },
    {
      // Must observe every route AS it registers - added before
      // `registerIdentityRoutes` runs (buildIdentityApp's own ordering).
      beforeRegister: (a) => {
        a.addHook('onRoute', (routeOptions) => {
          const methods = Array.isArray(routeOptions.method)
            ? routeOptions.method
            : [routeOptions.method];
          for (const method of methods) {
            registeredRoutes.push({ method: String(method), path: routeOptions.url });
          }
        });
      },
    },
  );

  // --- appDefaultTrustProxy (FIX 9) ---------------------------------------
  const configDefaultTrustProxy = buildTestConfig({
    RATE_LIMIT_AUTH_IP_CAPACITY: '1',
    RATE_LIMIT_AUTH_IP_WINDOW_SEC: '900',
    RATE_LIMIT_AUTH_ACCOUNT_CAPACITY: '30',
    RATE_LIMIT_AUTH_ACCOUNT_WINDOW_SEC: '900',
    // TRUST_PROXY intentionally omitted - proving the DEFAULT (false).
  });
  appDefaultTrustProxy = await buildIdentityApp({
    pool,
    tenantDb,
    redis,
    config: configDefaultTrustProxy,
  });
});

afterAll(async () => {
  await app.close();
  await appDefaultTrustProxy.close();
  await cleanupCreatedIdentityRecords(pool, redis, createdUserIds, createdClientIds);
  redis.disconnect();
  await pool.end();
});

describe('identity routes (P04a Unit UA6, HTTP wiring)', () => {
  it('every_implemented_route_exists_in_the_contract', () => {
    // `authPasswordContract` (P28 U2/U3c: change/forgot/reset password +
    // `impersonationRefresh`) is a SIBLING barrel to `authContract`, not a
    // member of it (`auth-password.ts`'s own split-out-for-max-lines doc
    // comment) - both are checked here, or a route implemented from the
    // sibling barrel (this unit's `POST /v1/auth/impersonation/refresh`,
    // the first one actually registered) would fail this structural check
    // even though it IS declared, just in the other barrel.
    const contractRoutes = [
      ...Object.values(authContract),
      ...Object.values(authPasswordContract),
    ].map((c) => {
      const contract = c as { '~orpc': { route: { method: string; path: string } } };
      return contract['~orpc'].route;
    });

    const implementedAuthRoutes = registeredRoutes.filter(
      // HEAD is Fastify's own implicit addition for every GET route, not
      // something this unit registered - excluded from this structural check.
      (route) => route.path.startsWith('/v1/auth/') && route.method !== 'HEAD',
    );
    expect(implementedAuthRoutes.length).toBeGreaterThan(0);

    for (const route of implementedAuthRoutes) {
      const matches = contractRoutes.some(
        (contractRoute) =>
          contractRoute.method === route.method && contractRoute.path === route.path,
      );
      expect(matches, `${route.method} ${route.path} is not declared in authContract`).toBe(true);
    }
  });

  it('fix9_trust_proxy_at_its_default_false_ignores_x_forwarded_for_and_shares_one_bucket', async () => {
    // appDefaultTrustProxy: RATE_LIMIT_AUTH_IP_CAPACITY=1, TRUST_PROXY unset
    // (default false) - two requests with DIFFERENT X-Forwarded-For values
    // must still land in the SAME bucket (the header is ignored) because
    // `req.ip` falls back to the real (mocked) socket address, which is the
    // SAME for both calls below - the SECOND request is denied even though
    // its header claims a fresh IP. A fresh `remoteAddress` per test run
    // (rather than light-my-request's shared default) keeps this test
    // independent of any earlier run's leftover Redis bucket state.
    const email = uniqueEmail('trust-proxy-default');
    const realSocketAddress = uniqueIp();

    const first = await appDefaultTrustProxy.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: realSocketAddress,
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(first.statusCode).not.toBe(429);

    const second = await appDefaultTrustProxy.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: realSocketAddress,
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email, password: STRONG_PASSWORD },
    });
    expect(second.statusCode).toBe(429);
  });

  it('fix12_rate_limit_account_keys_never_contain_the_raw_email', async () => {
    const email = uniqueEmail('pii-in-redis-keys');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-forwarded-for': uniqueIp() },
      payload: { email, password: STRONG_PASSWORD },
    });

    const keys = await redis.keys(sysKey(config.NODE_ENV, 'rl', 'acct', '*'));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(email);
      expect(key.toLowerCase()).not.toContain(email.toLowerCase());
    }
  });
});
