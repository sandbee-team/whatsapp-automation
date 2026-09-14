// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { ToastProvider } from '@wp/ui';
import type { MeOutput } from '../../features/auth/index.js';
import { AppShell } from '../app-shell.js';
import { AppI18nProvider } from '../../providers/i18n-provider.js';
import { ThemeProvider } from '../../providers/theme-provider.js';

/**
 * app-shell.test.tsx (P26b U2) - the shell contract: every nav item from
 * `NAV_GROUPS` renders with the right test id, the active item is marked
 * via `aria-current="page"`, the collapse toggle persists to
 * `localStorage['wp.sidebar']`, the mobile nav sheet opens on the hamburger,
 * the user menu shows name/email and its logout item calls the logout API,
 * and Ctrl+K opens the command palette and Enter navigates. Built on a
 * MINIMAL route tree (root -> `_authed` -> a couple of leaf routes) rather
 * than the full generated `routeTree.gen.ts`, so this test never needs to
 * stub every real leaf route's own data fetches - only the shell's own
 * dependencies (`/v1/notifications/unread-count`, the SSE stream).
 *
 * `_authed`'s component wraps `ToastProvider` around `AppShell` in the real
 * route tree (`routes/_authed.tsx`) - `NotificationBell` (mounted inside
 * `AppShell`'s top bar) calls `useToast()`, so this minimal tree mirrors that
 * same wrapping (C2 hardening: this test previously rendered `AppShell`
 * directly under no `ToastProvider` at all).
 */

const ME: MeOutput = {
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'owner@example.com',
    fullName: 'Ada Owner',
    emailVerifiedAt: '2026-01-01T00:00:00.000Z',
    mfaEnabledAt: null,
  },
  client: {
    id: '22222222-2222-2222-2222-222222222222',
    companyName: 'Acme Textiles',
    onboardingStep: 'done',
    status: 'active',
  },
  membership: { role: 'owner' },
};

function stubFetch(): void {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/notifications/unread-count')) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: { count: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url.includes('/v1/events')) {
      // Never resolves - the shared SSE connection stays open for the test's lifetime.
      return new Promise<Response>(() => undefined);
    }
    if (url.includes('/v1/wallet')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              balanceMinor: 50_000,
              state: 'active',
              lowBalanceThresholdMinor: 5_000,
              maxRateMinor: 100,
              estimatedMessagesRemaining: 500,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
}

function buildRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_authed',
    loader: () => ({ me: ME }),
    component: () => (
      <ToastProvider dismissLabel="Close">
        <AppShell />
      </ToastProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/',
    component: () => <div data-testid="dashboard-screen">dashboard</div>,
  });
  const instancesRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: '/instances',
    component: () => <div data-testid="instances-screen">instances</div>,
  });
  const routeTree = rootRoute.addChildren([authedRoute.addChildren([indexRoute, instancesRoute])]);

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

function renderShell(initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = buildRouter(initialPath);
  render(
    <AppI18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </AppI18nProvider>,
  );
  return { router };
}

describe('AppShell', () => {
  beforeEach(() => {
    stubFetch();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('renders_every_nav_item_and_marks_the_active_one', async () => {
    renderShell('/instances');

    await screen.findByTestId('instances-screen');

    expect(screen.getAllByTestId('nav-dashboard')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-instances')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-messages')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-unresolved')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-broadcasts')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-contacts')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-groups')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-webhooks')[0]).not.toBeUndefined();
    expect(screen.getAllByTestId('nav-wallet')[0]).not.toBeUndefined();

    const activeInstancesLinks = screen.getAllByTestId('nav-instances');
    expect(activeInstancesLinks.some((el) => el.getAttribute('aria-current') === 'page')).toBe(
      true,
    );
    const dashboardLinks = screen.getAllByTestId('nav-dashboard');
    expect(dashboardLinks.every((el) => el.getAttribute('aria-current') !== 'page')).toBe(true);
  });

  it('collapse_toggle_persists_to_local_storage', async () => {
    renderShell('/');
    await screen.findByTestId('dashboard-screen');

    const toggles = screen.getAllByTestId('sidebar-collapse-toggle');
    fireEvent.click(toggles[0]!);

    expect(window.localStorage.getItem('wp.sidebar')).toBe('collapsed');
  });

  it('mobile_nav_opens_the_sheet', async () => {
    renderShell('/');
    await screen.findByTestId('dashboard-screen');

    const openButtons = screen.getAllByRole('button', { name: 'Open navigation' });
    fireEvent.click(openButtons[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByTestId('nav-instances').length).toBeGreaterThan(0);
  });

  it('user_menu_shows_name_and_email_and_logout_calls_the_api', async () => {
    renderShell('/');
    await screen.findByTestId('dashboard-screen');

    const triggers = screen.getAllByTestId('logout-button');
    fireEvent.click(triggers[0]!);

    await screen.findByText('Ada Owner');
    expect(screen.getByText('owner@example.com')).not.toBeUndefined();

    const logoutItems = screen.getAllByText('Log out');
    fireEvent.click(logoutItems[0]!);

    await waitFor(() => {
      const calledLogout = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        (call: unknown[]) => {
          const input = call[0] as RequestInfo | URL;
          return (typeof input === 'string' ? input : input.toString()).includes('/v1/auth/logout');
        },
      );
      expect(calledLogout).toBe(true);
    });
  });

  it('ctrl_k_opens_the_palette_and_enter_navigates', async () => {
    renderShell('/');
    await screen.findByTestId('dashboard-screen');

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });

    const combobox = await screen.findByRole('combobox');
    fireEvent.change(combobox, { target: { value: 'Numbers' } });
    fireEvent.keyDown(combobox, { key: 'Enter' });

    await screen.findByTestId('instances-screen');
  });
});
