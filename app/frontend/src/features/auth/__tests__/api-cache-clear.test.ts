// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { queryClient } from '../../../providers/query-client.js';
import { login, totpVerify, totpRecovery } from '../api.js';

/**
 * api-cache-clear.test.ts (P26b C1 fix round CRITICAL-3) - tenant isolation:
 * the shared module-level `queryClient` (`providers/query-client.ts`) was
 * previously cleared ONLY on logout (`user-menu.tsx`); every successful
 * login path navigated client-side without clearing it, so a second user
 * signing in on the same tab could see the FIRST user's cached workspace
 * data (dashboard/instances/wallet/notifications) until a refetch happened
 * to land. Fixed at the source: `login`/`totpVerify`/`totpRecovery` each
 * clear the shared `queryClient` right where they call `setAccessToken`.
 *
 * Asserts against the REAL shared singleton (not a fresh `QueryClient()`)
 * so this proves the fix is wired to the exact instance the rest of the app
 * reads from, not merely that SOME client gets cleared.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('auth api clears the shared queryClient on every successful session start', () => {
  afterEach(() => {
    cleanup();
  });

  function cleanup(): void {
    queryClient.clear();
    vi.unstubAllGlobals();
  }

  it('login_with_an_authenticated_result_clears_the_shared_query_client', async () => {
    queryClient.setQueryData(['dashboard', 'summary'], { connectedNumbers: 3 });
    expect(queryClient.getQueryData(['dashboard', 'summary'])).toBeTruthy();

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            kind: 'authenticated',
            accessToken: 'token-1',
            user: { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.com', fullName: 'A B' },
          }),
        ),
      ),
    );

    await login({ email: 'a@b.com', password: 'correct horse battery staple' });

    expect(queryClient.getQueryData(['dashboard', 'summary'])).toBeUndefined();
  });

  it('login_with_an_mfa_required_result_does_NOT_clear_the_cache_yet_no_session_started', async () => {
    queryClient.setQueryData(['dashboard', 'summary'], { connectedNumbers: 3 });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ kind: 'mfa_required', mfaToken: 'mfa-1' }))),
    );

    await login({ email: 'a@b.com', password: 'correct horse battery staple' });

    // No access token was set yet (still awaiting TOTP) - the previous
    // tenant's cache must not be torn down before a session actually starts.
    expect(queryClient.getQueryData(['dashboard', 'summary'])).toBeTruthy();
  });

  it('totpVerify_clears_the_shared_query_client', async () => {
    queryClient.setQueryData(['instances', 'list'], [{ id: 'x' }]);

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            accessToken: 'token-2',
            user: { id: '22222222-2222-4222-8222-222222222222', email: 'c@d.com', fullName: 'C D' },
          }),
        ),
      ),
    );

    await totpVerify({ mfaToken: 'mfa-1', code: '123456' });

    expect(queryClient.getQueryData(['instances', 'list'])).toBeUndefined();
  });

  it('totpRecovery_clears_the_shared_query_client', async () => {
    queryClient.setQueryData(['wallet', 'summary'], { balanceMinor: '100' });

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            accessToken: 'token-3',
            user: { id: '33333333-3333-4333-8333-333333333333', email: 'e@f.com', fullName: 'E F' },
          }),
        ),
      ),
    );

    await totpRecovery({ mfaToken: 'mfa-1', recoveryCode: 'abc12345' });

    expect(queryClient.getQueryData(['wallet', 'summary'])).toBeUndefined();
  });
});

// Sanity: the shared singleton really is a QueryClient instance (guards
// against a future refactor accidentally swapping it for a plain object).
describe('sanity', () => {
  it('the_shared_queryClient_export_is_a_real_QueryClient', () => {
    expect(queryClient).toBeInstanceOf(QueryClient);
  });
});
