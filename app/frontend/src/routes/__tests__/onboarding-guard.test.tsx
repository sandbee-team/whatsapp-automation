// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { queryClient } from '../../providers/query-client.js';
import { setAccessToken } from '../../lib/api-client.js';
import * as apiClient from '../../lib/api-client.js';
import { routeTree } from '../../routeTree.gen.js';
import { AppI18nProvider } from '../../providers/i18n-provider.js';

/**
 * onboarding-guard.test.tsx (2026-09-08 panel refresh defect fix) - `/onboarding`
 * previously had no session guard: a hard load with no access token fired
 * `GET /v1/onboarding` unauthenticated, got a 401, and rendered a blank page.
 * Mirrors `_authed.tsx`'s `beforeLoad` guard (see `authed-guard.test.tsx`):
 * an unauthenticated visit redirects to `/login` before the wizard's own
 * fetches ever run; an authenticated visit renders the wizard normally.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/onboarding guard', () => {
  beforeEach(() => {
    setAccessToken(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('an_unauthenticated_visit_redirects_to_login_before_any_fetch', async () => {
    vi.spyOn(apiClient, 'ensureSession').mockResolvedValue(false);

    const fetchMock = vi.fn(() => {
      throw new Error('no onboarding fetch should ever be attempted before the redirect');
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });

    expect(screen.queryByTestId('wizard-verify-email')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an_authenticated_visit_renders_the_wizard', async () => {
    vi.spyOn(apiClient, 'ensureSession').mockResolvedValue(true);

    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/onboarding')) {
        return Promise.resolve(jsonResponse({ step: 'verify_email' }));
      }
      if (url.includes('/v1/events')) {
        return new Promise<Response>(() => undefined);
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);

    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
    });

    render(
      <AppI18nProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AppI18nProvider>,
    );

    await screen.findByTestId('wizard-verify-email');
    expect(router.state.location.pathname).toBe('/onboarding');
  });
});
