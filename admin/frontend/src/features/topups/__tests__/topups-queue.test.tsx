// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { TopupsQueue } from '../components/topups-queue.js';

/**
 * topups-queue.test.tsx (P28 Unit U6, step 9) - a stub payload smuggling
 * `externalRef: 'SECRET-UTR'` on one row is never rendered.
 * `adminTopupItemSchema.strict()` rejects the unplanned field during
 * per-item `safeParse` (`listTopups`) - defense in depth means that ROW is
 * dropped from the page entirely rather than the field being silently
 * stripped and the rest of the row rendered, so the DOM proof is that the
 * raw string never appears anywhere while a second, clean row on the same
 * page still renders normally. `TopupsQueue` reads the staff role via
 * `useStaffMe()` (`getRouteApi('/_authed').useLoaderData()`), so the route
 * tree here carries a real `/_authed` id with loader data, same shape the
 * real app provides.
 */
function topupsResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        items: [
          {
            id: '11111111-1111-7111-8111-111111111111',
            clientId: '22222222-2222-7222-8222-222222222222',
            amountMinor: '150000',
            method: 'upi',
            status: 'pending',
            createdAt: '2026-09-01T00:00:00.000Z',
          },
          {
            id: '33333333-3333-7333-8333-333333333333',
            clientId: '44444444-4444-7444-8444-444444444444',
            amountMinor: '250000',
            method: 'bank_transfer',
            status: 'pending',
            createdAt: '2026-09-02T00:00:00.000Z',
            // Smuggled field - not in adminTopupItemSchema, this whole row must be dropped.
            externalRef: 'SECRET-UTR',
          },
        ],
        nextCursor: null,
      },
      meta: { requestId: 'req-1' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function renderTopups(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(topupsResponse())),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute();
  const authedRoute = createRoute({
    id: '/_authed',
    getParentRoute: () => rootRoute,
    loader: () => ({
      me: { staffId: 's1', fullName: 'Staff One', role: 'superadmin' as const, actions: [] },
    }),
  });
  const topupsRoute = createRoute({
    path: '/topups',
    getParentRoute: () => authedRoute,
    component: TopupsQueue,
  });
  const routeTree = rootRoute.addChildren([authedRoute.addChildren([topupsRoute])]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/topups'] }),
  });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ToastProvider dismissLabel="Close">
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('topup_rows_never_render_an_external_ref', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the smuggled externalRef never appears anywhere in the rendered table', async () => {
    renderTopups();

    await waitFor(() => {
      expect(screen.getByText('upi')).toBeTruthy();
    });

    expect(screen.queryByText('SECRET-UTR')).toBeNull();
    expect(document.body.textContent).not.toContain('SECRET-UTR');
  });
});
