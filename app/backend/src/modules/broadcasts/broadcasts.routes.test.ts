import '../realtime/__test-support__/stub-wp-server-kit-env.js';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { registerBroadcastRoutes } from './broadcasts.routes.js';
import * as lifecycleService from './lifecycle.service.js';
import { assertUserActor } from './lifecycle.service.js';
import * as preflightPublic from './preflight.public.js';
import { BroadcastActorForbiddenError } from './broadcasts.errors.js';

/**
 * broadcasts.routes.test.ts (P23 Unit U5, step 6) - unit test over the HTTP
 * surface only: every mutation route requires an `Idempotency-Key` header
 * BEFORE the service is ever called (same idiom as `restamp.routes.test.ts`
 * - `authenticateRequest` mocked to a fixed authenticated MFA'd context, so
 * this file is about `broadcasts.routes.ts`'s OWN validation order). The
 * "api_key actor cannot start or cancel" proof runs directly against
 * `lifecycle.service.ts#assertUserActor` (the actor gate) - no HTTP path in
 * this codebase ever produces a non-`'user'` actor (route-policy.ts's
 * `authenticateRequest` only ever populates `{ kind: 'user' }` from a valid
 * JWT), so the gate itself is the thing to prove, not a fabricated HTTP path.
 */

vi.mock('../../platform/http/auth-plugin.js', () => ({
  authenticateRequest: vi.fn(async () => ({
    claims: { sub: 'user-1', sid: 'session-1', clientId: 'client-1', role: 'owner', epoch: 1 },
    mfa: true,
  })),
}));

vi.mock('./lifecycle.service.js', async () => {
  const actual =
    await vi.importActual<typeof import('./lifecycle.service.js')>('./lifecycle.service.js');
  return {
    ...actual,
    createBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    startBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    pauseBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    resumeBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    cancelBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    getBroadcast: vi.fn(async () => ({ id: 'campaign-1' })),
    listBroadcasts: vi.fn(async () => ({ items: [] })),
  };
});

vi.mock('./preflight.public.js', () => ({
  preflightBroadcast: vi.fn(async () => ({ broadcastId: 'campaign-1' })),
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
  registerBroadcastRoutes(app, { tenantDb: {} as never, publishWake: () => {} }, noopAuthDeps());
  return app;
}

const CAMPAIGN_ID = '0b3da4b1-9a85-41ae-bdd4-1383b585539e';
const IDEMPOTENCY_KEY = 'a-valid-key-000000000000000000';

const MUTATION_ROUTES: Array<{
  path: string;
  spy: () => Mock;
  payload?: Record<string, unknown>;
}> = [
  {
    path: '/v1/broadcasts',
    spy: () => vi.mocked(lifecycleService.createBroadcast),
    payload: {
      name: 'test',
      instanceId: CAMPAIGN_ID,
      audience: { kind: 'contacts', contactIds: [CAMPAIGN_ID] },
      message: { kind: 'text', body: 'hi' },
    },
  },
  {
    path: `/v1/broadcasts/${CAMPAIGN_ID}/start`,
    spy: () => vi.mocked(lifecycleService.startBroadcast),
  },
  {
    path: `/v1/broadcasts/${CAMPAIGN_ID}/pause`,
    spy: () => vi.mocked(lifecycleService.pauseBroadcast),
  },
  {
    path: `/v1/broadcasts/${CAMPAIGN_ID}/resume`,
    spy: () => vi.mocked(lifecycleService.resumeBroadcast),
  },
  {
    path: `/v1/broadcasts/${CAMPAIGN_ID}/cancel`,
    spy: () => vi.mocked(lifecycleService.cancelBroadcast),
  },
];

describe('broadcasts.routes (P23 Unit U5, step 6)', () => {
  it('a_broadcast_mutation_without_an_idempotency_key_is_rejected', async () => {
    const app = buildApp();

    for (const route of MUTATION_ROUTES) {
      route.spy().mockClear();

      const response = await app.inject({
        method: 'POST',
        url: route.path,
        headers: { authorization: 'Bearer x' },
        payload: route.payload ?? {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect(route.spy()).not.toHaveBeenCalled();
    }
  });

  it('a_valid_mutation_calls_the_service_exactly_once', async () => {
    const app = buildApp();

    for (const route of MUTATION_ROUTES) {
      route.spy().mockClear();

      const response = await app.inject({
        method: 'POST',
        url: route.path,
        headers: { authorization: 'Bearer x', 'idempotency-key': IDEMPOTENCY_KEY },
        payload: route.payload ?? {},
      });

      expect(response.statusCode).toBeLessThan(300);
      expect(route.spy()).toHaveBeenCalledTimes(1);
    }
  });

  it('an_api_key_actor_cannot_start_or_cancel', () => {
    expect(() => assertUserActor({ kind: 'api_key' })).toThrow(BroadcastActorForbiddenError);
    expect(() => assertUserActor({ kind: 'system' })).toThrow(BroadcastActorForbiddenError);
    expect(() => assertUserActor({ kind: 'user' })).toThrow(BroadcastActorForbiddenError);
    expect(() => assertUserActor({ kind: 'user', userId: '' })).toThrow(
      BroadcastActorForbiddenError,
    );
    expect(() => assertUserActor({ kind: 'user', userId: 'u1' })).not.toThrow();
  });

  it('create_then_start_accepts_the_contract_payload_end_to_end', async () => {
    const app = buildApp();
    vi.mocked(lifecycleService.createBroadcast).mockClear();
    vi.mocked(lifecycleService.startBroadcast).mockClear();

    const createResponse = await app.inject({
      method: 'POST',
      url: '/v1/broadcasts',
      headers: { authorization: 'Bearer x', 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {
        name: 'test',
        instanceId: CAMPAIGN_ID,
        audience: { kind: 'contacts', contactIds: [CAMPAIGN_ID] },
        message: { kind: 'text', body: 'hi' },
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(lifecycleService.createBroadcast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lifecycleService.createBroadcast).mock.calls[0]?.[1]).toMatchObject({
      name: 'test',
      instanceId: CAMPAIGN_ID,
      audience: { kind: 'contacts', contactIds: [CAMPAIGN_ID] },
      message: { kind: 'text', body: 'hi' },
      priority: 'low',
      scheduledAt: null,
    });

    const startResponse = await app.inject({
      method: 'POST',
      url: `/v1/broadcasts/${CAMPAIGN_ID}/start`,
      headers: { authorization: 'Bearer x', 'idempotency-key': IDEMPOTENCY_KEY },
      payload: {},
    });

    expect(startResponse.statusCode).toBe(200);
    expect(lifecycleService.startBroadcast).toHaveBeenCalledTimes(1);
  });

  it('preflight_route_calls_the_service_once_and_returns_the_quote', async () => {
    const app = buildApp();
    const spy = vi.mocked(preflightPublic.preflightBroadcast);
    spy.mockClear();
    spy.mockResolvedValueOnce({ broadcastId: CAMPAIGN_ID } as never);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/broadcasts/${CAMPAIGN_ID}/preflight`,
      headers: { authorization: 'Bearer x' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(response.json().data).toEqual({ broadcastId: CAMPAIGN_ID });
  });
});
