import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, setAccessToken } from './api-client.js';

/**
 * api-client.test.ts (P04b, second-bug fix) - proves the refresh call is
 * shared across concurrent 401s. Two callers racing a 401 at the same
 * moment must never issue two parallel `POST /v1/auth/refresh` calls: the
 * refresh cookie is a one-shot rotating token, and the backend's rotation
 * claim gate treats a SECOND concurrent presentation of the same cookie as
 * reuse, revoking the whole session chain (session.service.ts). See
 * .memory/lessons/2026-08-27-strictmode-double-effect-consumes-single-use-token.md.
 */
describe('apiFetch 401 -> refresh', () => {
  beforeEach(() => {
    setAccessToken(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('shares ONE in-flight refresh call across two concurrent 401s', async () => {
    let refreshCalls = 0;
    const jsonBody = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === '/v1/auth/refresh' && method === 'POST') {
        refreshCalls += 1;
        return Promise.resolve(jsonBody({ data: { accessToken: 'new-token' } }));
      }

      if (url === '/v1/protected') {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === 'Bearer new-token') {
          return Promise.resolve(jsonBody({ data: { ok: true } }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r1' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      apiFetch<{ ok: boolean }>('/v1/protected'),
      apiFetch<{ ok: boolean }>('/v1/protected'),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
  });

  it('a_transport_level_refresh_failure_resolves_to_ApiError_not_a_raw_throw', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === '/v1/auth/refresh' && method === 'POST') {
        return Promise.reject(new TypeError('network error (simulated transport failure)'));
      }

      if (url === '/v1/protected') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'UNAUTHENTICATED', message: 'no', requestId: 'r1' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
        );
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { assign: vi.fn() } });

    await expect(apiFetch('/v1/protected')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'UNAUTHENTICATED',
    });
  });
});

/**
 * apiFetch PATCH/DELETE (P15 U6b) - the method union widened from
 * `'GET' | 'POST'` to also carry `'PATCH' | 'DELETE'` (webhooks re-enable +
 * delete). This is a pass-through widening only - proves both methods reach
 * `fetch` unchanged and the JSON body still round-trips, same as the
 * existing GET/POST behavior, no new retry/refresh semantics.
 */
describe('apiFetch PATCH/DELETE', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('sends a PATCH request with a JSON body and returns the parsed data', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toBe('/v1/webhooks/endpoints/abc');
      expect(init?.method).toBe('PATCH');
      expect(init?.body).toBe(JSON.stringify({ enabled: true }));
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: 'abc', enabled: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ id: string; enabled: boolean }>('/v1/webhooks/endpoints/abc', {
      method: 'PATCH',
      body: { enabled: true },
    });

    expect(result).toEqual({ id: 'abc', enabled: true });
  });

  it('sends a DELETE request with no body and returns the parsed data', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      expect(url).toBe('/v1/webhooks/endpoints/abc');
      expect(init?.method).toBe('DELETE');
      expect(init?.body).toBeUndefined();
      return Promise.resolve(
        new Response(JSON.stringify({ data: { id: 'abc' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await apiFetch<{ id: string }>('/v1/webhooks/endpoints/abc', {
      method: 'DELETE',
    });

    expect(result).toEqual({ id: 'abc' });
  });
});
