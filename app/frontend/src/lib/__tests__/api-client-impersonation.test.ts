// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  clearImpersonatedSession,
  markImpersonatedSession,
  setAccessToken,
} from '../api-client.js';

/**
 * api-client-impersonation.test.ts (P28 Unit U7) - proves the 401
 * refresh-and-retry path branches to `POST /v1/auth/impersonation/refresh`
 * (bearer token, no cookie) instead of the normal cookie-based
 * `/v1/auth/refresh` while `markImpersonatedSession()` is set, and that a
 * failed impersonated refresh clears BOTH the in-memory token and the
 * impersonation flag before redirecting to `/login` - same fail-closed shape
 * as the existing cookie-refresh-failure path in `api-client.test.ts`.
 */
function jsonBody(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function unauthenticated(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r1' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

describe('impersonated session refresh routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
    clearImpersonatedSession();
  });

  it('impersonated_refresh_uses_the_bearer_endpoint_not_the_cookie', async () => {
    setAccessToken('impersonation-token');
    markImpersonatedSession();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === '/v1/auth/impersonation/refresh' && method === 'POST') {
        expect(init?.credentials).toBeUndefined();
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          'Bearer impersonation-token',
        );
        return Promise.resolve(
          jsonBody({
            data: { accessToken: 'refreshed-token', expiresAt: '2026-09-08T00:00:00.000Z' },
          }),
        );
      }

      if (url === '/v1/auth/refresh') {
        throw new Error(
          'the cookie refresh endpoint must never be called for an impersonated session',
        );
      }

      if (url === '/v1/protected') {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === 'Bearer refreshed-token') {
          return Promise.resolve(jsonBody({ data: { ok: true } }));
        }
        return Promise.resolve(unauthenticated());
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ ok: boolean }>('/v1/protected');

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.some((call) => call[0] === '/v1/auth/impersonation/refresh')).toBe(
      true,
    );
  });

  it('a_failed_impersonated_refresh_clears_the_session', async () => {
    setAccessToken('impersonation-token');
    markImpersonatedSession();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === '/v1/auth/impersonation/refresh' && method === 'POST') {
        return Promise.resolve(unauthenticated());
      }
      if (url === '/v1/protected') {
        return Promise.resolve(unauthenticated());
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign }, sessionStorage: window.sessionStorage });

    await expect(apiFetch('/v1/protected')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(assign).toHaveBeenCalledWith('/login');
    expect(window.sessionStorage.getItem('wp.imp')).toBeNull();
  });
});
