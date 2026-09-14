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
import { Sidebar } from '../sidebar.js';
import { NAV_GROUPS } from '../nav-config.js';
import type { MessageKey } from '@wp/i18n';

const EN_GROUP_LABELS: Partial<Record<MessageKey, string>> = {
  'nav.overview': 'Overview',
  'nav.messaging': 'Messaging',
  'nav.audience': 'Audience',
  'nav.settings': 'Settings',
};

/**
 * sidebar-layout.test.tsx (defect A - expanded sidebar overflow at 1280x800)
 * - proves the tightened layout budget from the sidebar/sidebar-nav/
 * sidebar-wallet-card JSDoc: the nav scrolls internally (thin scrollbar
 * classes) instead of pushing the footer off-screen, items are `h-9`, the
 * wallet mini-card hides itself below a 780px-tall viewport via the
 * arbitrary media variant, and every group label + nav item from
 * `NAV_GROUPS` still renders in the expanded desktop sidebar. Same raw-
 * `fetch`-stub idiom as `sidebar-wallet-card.test.tsx`.
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

function renderSidebar() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(walletSummaryResponse())),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <Sidebar
        companyName="Acme Textiles"
        realtimeState="live"
        collapsed={false}
        onCollapsedChange={() => undefined}
      />
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

describe('Sidebar expanded layout budget (defect A)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('nav_container_scrolls_internally_with_a_thin_scrollbar', async () => {
    renderSidebar();

    const dashboardLink = await screen.findByTestId('nav-dashboard');
    const nav = dashboardLink.closest('nav');
    expect(nav).not.toBeNull();
    expect(nav?.className).toContain('overflow-y-auto');
    expect(nav?.className).toContain('[scrollbar-width:thin]');
    expect(nav?.className).toContain('[scrollbar-color:var(--color-border)_transparent]');
  });

  it('nav_items_are_h_9', async () => {
    renderSidebar();
    await screen.findByTestId('nav-dashboard');

    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        const link = screen.getByTestId(item.testId);
        expect(link.className).toContain('h-9');
      }
    }
  });

  it('wallet_card_root_hides_below_a_780px_tall_viewport', async () => {
    renderSidebar();

    const card = await screen.findByTestId('sidebar-wallet-card');
    expect(card.className).toContain('[@media(max-height:780px)]:hidden');
  });

  it('every_group_label_and_nav_item_renders_in_the_expanded_sidebar', async () => {
    renderSidebar();
    await screen.findByTestId('nav-dashboard');

    for (const group of NAV_GROUPS) {
      const label = EN_GROUP_LABELS[group.labelKey];
      expect(label).not.toBeUndefined();
      expect(screen.getByText(label as string)).not.toBeUndefined();
      for (const item of group.items) {
        expect(screen.getByTestId(item.testId)).not.toBeUndefined();
      }
    }

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-wallet-card')).not.toBeUndefined();
    });
  });
});
