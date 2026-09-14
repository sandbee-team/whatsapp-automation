// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider } from '@wp/ui';
import type { MeOutput } from '../../../features/auth/index.js';
import { setAccessToken } from '../../../lib/api-client.js';
import { UserMenu } from '../user-menu.js';

/**
 * user-menu-logout-cache-isolation.test.tsx (P26b C2 hardening) - tenant-
 * isolation proof at the UI cache layer: a query cached under the CURRENT
 * workspace's session must not survive logout into whatever comes next
 * (core invariant 4). `UserMenu#onLogout` already calls `queryClient.clear()`
 * before navigating - this test proves it with a real cached query, rather
 * than reading the source and trusting it.
 */

const ME: MeOutput = {
  user: {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'a@example.com',
    fullName: 'Ada Example',
    emailVerifiedAt: null,
    mfaEnabledAt: null,
  },
  client: {
    id: '22222222-2222-4222-8222-222222222222',
    companyName: 'Acme',
    onboardingStep: 'done',
    status: 'active',
  },
  membership: { role: 'owner' },
};

/** Mounts UserMenu plus a sibling component that caches a "tenant-scoped" query under the same QueryClient. */
function TenantScopedProbe(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['tenant-scoped-probe'],
    queryFn: () => Promise.resolve('acme-secret-data'),
  });
  return <span data-testid="probe-value">{query.data ?? 'loading'}</span>;
}

function renderMenu(queryClient: QueryClient): void {
  const rootRoute = createRootRoute({
    component: () => (
      <div>
        <UserMenu me={ME} />
        <TenantScopedProbe />
      </div>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('UserMenu logout query-cache isolation', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('clears every cached query on logout - a query cached before logout is gone after it', async () => {
    setAccessToken('token');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderMenu(queryClient);

    // The probe's query is cached under the current (pre-logout) workspace.
    await waitFor(() => {
      expect(screen.getByTestId('probe-value').textContent).toBe('acme-secret-data');
    });
    expect(queryClient.getQueryData(['tenant-scoped-probe'])).toBe('acme-secret-data');
    expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('logout-button'));
    const logoutItem = await screen.findByText('Log out');
    fireEvent.click(logoutItem);

    await waitFor(() => {
      expect(queryClient.getQueryData(['tenant-scoped-probe'])).toBeUndefined();
    });
    // The whole cache is empty, not just the one key - `clear()`, not a
    // scoped `removeQueries`, so no OTHER stale tenant key can survive either.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
