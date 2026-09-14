// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider } from '@wp/ui';
import {
  clearImpersonatedSession,
  getAccessToken,
  isImpersonatedSession,
  setAccessToken,
} from '../../lib/api-client.js';
import { Route as ImpersonateRoute } from '../impersonate.js';

/**
 * impersonate-entry.test.tsx (P28 Unit U7) - proves the support-session
 * entry point keeps the staff token in MEMORY only (never `localStorage`),
 * records only the boolean impersonation flag in `sessionStorage`, and
 * strips the URL fragment so the token cannot be read back out of the
 * address bar or session history.
 */
function renderImpersonate(hash: string) {
  window.location.hash = hash;

  const rootRoute = createRootRoute();
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-testid="empty-dashboard">home</div>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="login-screen">login</div>,
  });
  const impersonateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/impersonate',
    component: ImpersonateRoute.options.component,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, loginRoute, impersonateRoute]),
    history: createMemoryHistory({ initialEntries: ['/impersonate'] }),
  });

  render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );

  return { router };
}

describe('/impersonate entry', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setAccessToken(null);
    clearImpersonatedSession();
    window.localStorage.clear();
    window.location.hash = '';
  });

  it('impersonate_route_stores_the_token_in_memory_only_and_strips_the_hash', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');

    const { router } = renderImpersonate('#token=staff-minted-jwt&exp=2026-09-08T11:00:00.000Z');

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });

    expect(getAccessToken()).toBe('staff-minted-jwt');
    expect(isImpersonatedSession()).toBe(true);
    // The token itself is NEVER persisted - only the boolean flag is.
    expect(window.sessionStorage.getItem('wp.imp')).toBe('1');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('staff-minted-jwt');
    expect(replaceState).toHaveBeenCalled();
    const replacedUrl = String(replaceState.mock.calls[0]?.[2] ?? '');
    expect(replacedUrl).not.toContain('staff-minted-jwt');
    expect(replacedUrl).not.toContain('#');
  });

  it('impersonate_route_without_a_token_shows_an_error', async () => {
    const { router } = renderImpersonate('');

    const error = await screen.findByTestId('impersonate-entry-error');
    expect(error.textContent).toContain('This support session link is not valid');
    expect(screen.getByTestId('impersonate-entry-return-to-login')).not.toBeNull();
    expect(getAccessToken()).toBeNull();
    expect(isImpersonatedSession()).toBe(false);
    expect(router.state.location.pathname).toBe('/impersonate');
  });
});
