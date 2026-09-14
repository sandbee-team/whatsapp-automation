import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireCanSend, requireCanSendForPrincipal, type GuardDeps } from './guards.js';
import type { AuthenticatedContext } from './route-policy.js';

/**
 * guards.test.ts (go-live U3) - `requireCanSendForPrincipal` carries the
 * pre-existing `requireCanSend` body, callable from EITHER a session
 * principal (`req.auth`) or an api-key principal (an api key inherits its
 * creator's entitlement, per the migration's own `created_by_user_id`
 * contract - a de-verified/suspended tenant's keys stop working the same
 * way its logged-in sessions would).
 */

function depsAllowing(): GuardDeps {
  return { entitlementCtx: {} as GuardDeps['entitlementCtx'] };
}

describe('requireCanSendForPrincipal', () => {
  it('is_called_with_the_clientId_and_userId_it_is_given', async () => {
    const deps = depsAllowing();
    const calls: Array<{ clientId: string; userId: string }> = [];

    vi.spyOn(await import('../../modules/tenancy/index.js'), 'assertCanSend').mockImplementation(
      async (_ctx, input) => {
        calls.push(input);
      },
    );

    await requireCanSendForPrincipal(deps, { clientId: 'client-1', userId: 'user-1' });

    expect(calls).toEqual([{ clientId: 'client-1', userId: 'user-1' }]);
    vi.restoreAllMocks();
  });
});

describe('requireCanSend (delegates to requireCanSendForPrincipal with req.auth)', () => {
  it('extracts_clientId_and_userId_from_req_auth', async () => {
    const deps = depsAllowing();
    const calls: Array<{ clientId: string; userId: string }> = [];

    vi.spyOn(await import('../../modules/tenancy/index.js'), 'assertCanSend').mockImplementation(
      async (_ctx, input) => {
        calls.push(input);
      },
    );

    const auth: AuthenticatedContext = {
      userId: 'user-2',
      sessionId: 'session-1',
      clientId: 'client-2',
      role: 'owner',
      epoch: 1,
    };
    const req = { auth } as unknown as FastifyRequest;

    await requireCanSend(deps, req);

    expect(calls).toEqual([{ clientId: 'client-2', userId: 'user-2' }]);
    vi.restoreAllMocks();
  });
});
