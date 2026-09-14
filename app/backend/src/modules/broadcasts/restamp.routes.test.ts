import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { registerRestampRoutes } from './restamp.routes.js';
import { restampBroadcast } from './restamp.service.js';

/**
 * restamp.routes.test.ts (P23 Unit U6, step 7) - unit test over the HTTP
 * surface only: a missing `Idempotency-Key` header is a 400 BEFORE the
 * service is ever called; an invalid body is likewise a 400 before the
 * service call. `authenticateRequest` is mocked to a fixed authenticated
 * MFA'd context so `session_mfa` enforcement passes trivially - this file
 * is about `restamp.routes.ts`'s OWN validation order, not the auth stack.
 */

vi.mock('../../platform/http/auth-plugin.js', () => ({
  authenticateRequest: vi.fn(async () => ({
    claims: { sub: 'user-1', sid: 'session-1', clientId: 'client-1', role: 'owner', epoch: 1 },
    mfa: true,
  })),
}));

vi.mock('./restamp.service.js', () => ({
  restampBroadcast: vi.fn(async () => ({ restamped: 0, sessionEpoch: 1 })),
}));

function noopAuthDeps(): AuthDeps {
  return {
    tokenEpochCtx: {} as AuthDeps['tokenEpochCtx'],
    db: {} as AuthDeps['db'],
    hasTotpEnrolled: async () => true,
  };
}

function buildApp() {
  const app = Fastify();
  registerRestampRoutes(app, { tenantDb: {} as never }, noopAuthDeps());
  return app;
}

describe('restamp.routes (P23 Unit U6, step 7)', () => {
  it('missing_idempotency_key_is_rejected_with_400_and_the_service_is_never_called', async () => {
    const app = buildApp();
    const mockedRestamp = vi.mocked(restampBroadcast);
    mockedRestamp.mockClear();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/broadcasts/0b3da4b1-9a85-41ae-bdd4-1383b585539e/restamp',
      headers: { authorization: 'Bearer x' },
      payload: { confirmCount: 5 },
    });

    expect(response.statusCode).toBe(400);
    expect(mockedRestamp).not.toHaveBeenCalled();
  });

  it('an_invalid_body_is_rejected_with_400_and_the_service_is_never_called', async () => {
    const app = buildApp();
    const mockedRestamp = vi.mocked(restampBroadcast);
    mockedRestamp.mockClear();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/broadcasts/0b3da4b1-9a85-41ae-bdd4-1383b585539e/restamp',
      headers: { authorization: 'Bearer x', 'idempotency-key': 'a-valid-key-000000000000000000' },
      payload: { confirmCount: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(mockedRestamp).not.toHaveBeenCalled();
  });

  it('a_valid_request_calls_the_service_exactly_once', async () => {
    const app = buildApp();
    const mockedRestamp = vi.mocked(restampBroadcast);
    mockedRestamp.mockClear();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/broadcasts/0b3da4b1-9a85-41ae-bdd4-1383b585539e/restamp',
      headers: { authorization: 'Bearer x', 'idempotency-key': 'a-valid-key-000000000000000000' },
      payload: { confirmCount: 5 },
    });

    expect(response.statusCode).toBe(200);
    expect(mockedRestamp).toHaveBeenCalledTimes(1);
  });
});
