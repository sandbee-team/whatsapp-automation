import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { assertRoutePolicyConfig, MfaRequiredError, registerRoute } from '../route-policy.js';
import type { AuthDeps } from '../auth-plugin.js';

/**
 * route-policy.test.ts (P04a Unit UA6) - fail-closed routing (canon): a
 * route registered without a valid auth policy, or without a scope, must
 * throw synchronously AT REGISTRATION TIME (before the app ever serves a
 * request), naming the offending route.
 */

function noopDeps(): AuthDeps {
  return {
    tokenEpochCtx: {} as AuthDeps['tokenEpochCtx'],
    db: {} as AuthDeps['db'],
    hasTotpEnrolled: async () => false,
  };
}

const JWT_SECRET = 'test-only-jwt-secret-at-least-32-chars-long!!';
const CURRENT_EPOCH = 1;

/** A minimal fake `TokenEpochCtx` - `redis.get` always misses so `getEpoch` falls through to `db.query`, which returns a fixed `token_epoch` row (no real PG/Redis - a pure unit test). */
function fakeSessionAuthDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    tokenEpochCtx: {
      redis: { get: async () => null } as unknown as AuthDeps['tokenEpochCtx']['redis'],
      db: {
        query: async () => ({ rows: [{ token_epoch: CURRENT_EPOCH }] }),
      } as unknown as AuthDeps['tokenEpochCtx']['db'],
      jwtSecret: JWT_SECRET,
      epochCacheTtlSec: 3600,
      env: 'test',
    },
    db: {} as AuthDeps['db'],
    hasTotpEnrolled: async () => true,
    ...overrides,
  };
}

/** Signs a real HS256 session access token (no `mfa` claim, i.e. a non-MFA session) for the `session_or_api_key_still_requires_mfa_for_a_human_session` proof below. */
async function signSessionToken(claims: {
  sub: string;
  sid: string;
  clientId: string;
  role: string;
  epoch: number;
  mfa?: boolean;
}): Promise<string> {
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('15m')
    .sign(secretKey);
}

describe('route-policy (P04a Unit UA6, fail-closed routing)', () => {
  it('a_route_registered_without_an_auth_policy_fails_to_register_at_boot', () => {
    const app = Fastify();

    expect(() =>
      registerRoute(app, noopDeps(), {
        method: 'GET',
        path: '/v1/no-policy',
        // policy intentionally omitted
        scope: 'test:no-policy',
        handler: async () => {},
      } as never),
    ).toThrow(/no-policy/);

    expect(() =>
      registerRoute(app, noopDeps(), {
        method: 'GET',
        path: '/v1/no-scope',
        policy: 'public',
        // scope intentionally omitted
        handler: async () => {},
      } as never),
    ).toThrow(/no-scope/);
  });

  it('m19_a_bare_route_that_bypasses_registerRoute_still_fails_the_build', () => {
    // M19 (P04a FIXB): `assertRoutePolicyConfig` (wired as an `onRoute` hook
    // in server.ts) makes fail-closed routing mechanical - it catches even a
    // route that never called `registerRoute` at all.
    const app = Fastify();
    app.addHook('onRoute', assertRoutePolicyConfig);

    expect(() => {
      app.get('/v1/bare', () => {
        /* never reached */
      });
    }).toThrow(/policy\/scope/);
  });

  it('m19_a_route_registered_through_registerRoute_passes_the_onRoute_hook', () => {
    const app = Fastify();
    app.addHook('onRoute', assertRoutePolicyConfig);

    expect(() =>
      registerRoute(app, noopDeps(), {
        method: 'GET',
        path: '/v1/ok',
        policy: 'public',
        scope: 'test:ok',
        handler: async () => {},
      }),
    ).not.toThrow();
  });

  it('session_or_api_key_still_requires_mfa_for_a_human_session', async () => {
    // Founder decision 2026-09-14: `session_or_api_key` authenticates an
    // api_key request by key, but a HUMAN session request on such a route
    // must still satisfy the SAME MFA check as `session_mfa` - never a
    // downgrade of the panel's own send path. A session bearer that starts
    // with something other than `wp_live_` runs the `session_mfa` branch
    // verbatim; a TOTP-enrolled user with a non-MFA token gets the exact
    // same MFA_REQUIRED rejection `session_mfa` itself would produce.
    const app = Fastify();
    const authDeps = fakeSessionAuthDeps({ hasTotpEnrolled: async () => true });

    registerRoute(app, authDeps, {
      method: 'GET',
      path: '/v1/messages',
      policy: 'session_or_api_key',
      scope: 'messages:send',
      handler: (_req, reply) => {
        reply.send({ ok: true });
      },
    });
    await app.ready();

    const token = await signSessionToken({
      sub: 'user-1',
      sid: 'session-1',
      clientId: 'client-1',
      role: 'member',
      epoch: CURRENT_EPOCH,
      // mfa claim intentionally omitted - a non-MFA session.
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/messages',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json() as { error: { code: string } };
      expect(body.error.code).toBe(new MfaRequiredError().code);
    } finally {
      await app.close();
    }
  });
});
