import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import { describe, expect, it, vi } from 'vitest';
import { registerInternalRoutes } from './index.js';
import type { InternalRoutesDeps } from './internal-routes-deps.js';

/**
 * internal-routes-deps.test.ts (C1 review round 2 MINOR fix) -
 * `registerInternalRoutes` throws AT WIRING TIME when `deps.auditWrite` (the
 * test-only `staff_audit_log` write override, see that field's own doc
 * comment) is set in a production runtime - it must never be reachable
 * outside a test process. `env` is an explicit optional parameter (defaults
 * to `@wp/server-kit`'s frozen `config.WP_ENV` singleton in production) so
 * this is testable without mutating that frozen config.
 */

const NOOP_AUTH_DEPS = {} as Parameters<typeof registerInternalRoutes>[2];

function minimalDeps(auditWrite: InternalRoutesDeps['auditWrite']): InternalRoutesDeps {
  return {
    pool: {} as InternalRoutesDeps['pool'],
    tenantDb: {} as InternalRoutesDeps['tenantDb'],
    publishWake: () => {},
    serviceTokenSecret: 'test-secret',
    allowedCidrs: '0.0.0.0/0',
    auditWrite,
  };
}

function fakeApp() {
  return { route: vi.fn() } as unknown as Parameters<typeof registerInternalRoutes>[0];
}

describe('registerInternalRoutes: auditWrite production guard', () => {
  it('throws_when_auditWrite_is_set_and_env_is_production', () => {
    expect(() =>
      registerInternalRoutes(
        fakeApp(),
        minimalDeps({ insert: vi.fn(), update: vi.fn() }),
        NOOP_AUTH_DEPS,
        {
          env: 'production',
        },
      ),
    ).toThrow(/auditWrite/i);
  });

  it('never_throws_when_auditWrite_is_set_and_env_is_test', () => {
    expect(() =>
      registerInternalRoutes(
        fakeApp(),
        minimalDeps({ insert: vi.fn(), update: vi.fn() }),
        NOOP_AUTH_DEPS,
        {
          env: 'test',
        },
      ),
    ).not.toThrow();
  });

  it('never_throws_when_auditWrite_is_undefined_even_in_production', () => {
    expect(() =>
      registerInternalRoutes(fakeApp(), minimalDeps(undefined), NOOP_AUTH_DEPS, {
        env: 'production',
      }),
    ).not.toThrow();
  });
});
