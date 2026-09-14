// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { SidebarWalletCard } from '../sidebar-wallet-card.js';

/**
 * sidebar-wallet-card.test.tsx (panel refresh spec section 4, unit S1) -
 * the sidebar footer wallet mini-card: loading renders a skeleton, a
 * successful `GET /v1/wallet` shows the formatted balance and estimate line,
 * and a failed fetch hides the card entirely (never a stale/undefined
 * balance). Same raw-`fetch`-stub idiom as `wallet-screen.test.tsx`.
 */
function walletSummaryResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        balanceMinor: 50_000,
        state: 'active',
        lowBalanceThresholdMinor: 5_000,
        maxRateMinor: 100,
        estimatedMessagesRemaining: 500,
      },
      meta: { requestId: 'r1' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function renderCard(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => fetchImpl()),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <SidebarWalletCard /> });
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

describe('SidebarWalletCard', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders_a_skeleton_while_loading', async () => {
    renderCard(() => new Promise<Response>(() => undefined));
    const card = await screen.findByTestId('sidebar-wallet-card');
    expect(card.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(screen.queryByText('₹500.00')).toBeNull();
  });

  it('shows_the_formatted_balance_and_estimate_once_loaded', async () => {
    renderCard(() => Promise.resolve(walletSummaryResponse()));

    await waitFor(() => {
      expect(screen.getByText('₹500.00')).not.toBeUndefined();
    });
    expect(screen.getByText(/500 messages/)).not.toBeUndefined();
    expect(screen.getByRole('link', { name: 'Add funds' })).not.toBeUndefined();
  });

  it('hides_the_card_entirely_on_a_fetch_error', async () => {
    renderCard(() => Promise.resolve(new Response('error', { status: 500 })));

    await screen.findByTestId('sidebar-wallet-card');
    await waitFor(() => {
      expect(screen.queryByTestId('sidebar-wallet-card')).toBeNull();
    });
  });
});
