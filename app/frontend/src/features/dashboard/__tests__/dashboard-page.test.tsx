// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { DashboardPage } from '../components/dashboard-page.js';

/**
 * dashboard-page.test.tsx (2026-09-08 panel refresh, unit S2) - stubbed
 * `fetch` for every query the page reads (`/v1/dashboard/summary`,
 * `/v1/queue-status`, `/v1/wallet`, `/v1/notifications` and
 * `/v1/instances/:id/card`), same `stubFetch` idiom as
 * `features/instances/__tests__/use-instance-list.test.tsx`. Covers the
 * zero-numbers state (checklist hero + `dashboard-numbers-empty`) and a
 * populated state (bar rows with exact `aria-valuenow`, donut legend values,
 * fleet-health ring exact score, wallet estimate text).
 */

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notificationsResponse(): Response {
  return json({ items: [], nextCursor: null });
}

function walletResponse(overrides: Partial<Record<string, unknown>> = {}): Response {
  return json({
    balanceMinor: 50_000,
    state: 'active',
    lowBalanceThresholdMinor: 5_000,
    maxRateMinor: 100,
    estimatedMessagesRemaining: 500,
    ...overrides,
  });
}

function card(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    instanceId: ID_A,
    label: 'Sales',
    linkState: 'linked',
    healthState: 'connected',
    desiredState: 'online',
    parked: false,
    needsUserAction: false,
    userActionReason: null,
    healthScore: 90,
    healthBand: 'HEALTHY',
    warmupTier: 1,
    warmupDay: 1,
    todaySent: 0,
    effDailyCap: 10,
    newConversationsToday: 0,
    effNewConvCap: 5,
    sendingWindow: { start: '09:00', end: '20:00', tz: 'Asia/Kolkata' },
    lastSendAt: null,
    queueDepth: 0,
    queueDepthCapped: false,
    oldestQueuedAgeSeconds: null,
    nextSendEarliestAt: null,
    serverNow: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function stubEmptyWorkspaceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/dashboard/summary')) {
        return json({ connectedNumbers: 0, queued: 0, sent: 0 });
      }
      if (url.includes('/v1/queue-status')) {
        return json({
          instances: [],
          workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
        });
      }
      if (url.includes('/v1/wallet')) return walletResponse({ state: 'empty', balanceMinor: 0 });
      if (url.includes('/v1/notifications')) return notificationsResponse();
      return new Response('not found', { status: 404 });
    }),
  );
}

function stubPopulatedWorkspaceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/dashboard/summary')) {
        return json({ connectedNumbers: 2, queued: 4, sent: 5 });
      }
      if (url.includes('/v1/queue-status')) {
        return json({
          instances: [
            { instanceId: ID_A, waiting: 3, sentToday: 5, failedToday: 1, spentTodayMinor: '250' },
            { instanceId: ID_B, waiting: 1, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
          ],
          workspace: { waiting: 4, sentToday: 5, failedToday: 1, spentTodayMinor: '250' },
        });
      }
      if (url.includes(`/v1/instances/${ID_A}/card`)) {
        return json(
          card({
            instanceId: ID_A,
            label: 'Sales',
            healthScore: 90,
            healthBand: 'HEALTHY',
            todaySent: 5,
            effDailyCap: 10,
          }),
        );
      }
      if (url.includes(`/v1/instances/${ID_B}/card`)) {
        return json(
          card({
            instanceId: ID_B,
            label: 'Support',
            healthScore: 70,
            healthBand: 'WATCH',
            todaySent: 0,
            effDailyCap: 8,
          }),
        );
      }
      if (url.includes('/v1/wallet')) return walletResponse();
      if (url.includes('/v1/notifications')) return notificationsResponse();
      return new Response('not found', { status: 404 });
    }),
  );
}

function renderDashboard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: DashboardPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <I18nProvider locale="en">
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('DashboardPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('zero numbers renders the getting-started hero and an empty bar list', async () => {
    stubEmptyWorkspaceFetch();
    renderDashboard();

    await waitFor(() => {
      expect(screen.getByTestId('getting-started-checklist')).toBeTruthy();
    });
    expect(screen.getByTestId('dashboard-numbers-empty')).toBeTruthy();
    expect(screen.getByTestId('dashboard-connect-cta')).toBeTruthy();
    expect(screen.getByTestId('dashboard-fleet-health').textContent).toContain(
      'Connect a number to start tracking health',
    );
  });

  it('a populated workspace renders exact bar values, donut legend and fleet score', async () => {
    stubPopulatedWorkspaceFetch();
    renderDashboard();

    await waitFor(() => {
      expect(screen.queryByTestId('getting-started-checklist')).toBeNull();
    });

    // "Sending today" bar list: exact aria-valuenow per row.
    const salesBar = await screen.findByRole('progressbar', { name: 'Sales' });
    expect(salesBar.getAttribute('aria-valuenow')).toBe('5');
    expect(salesBar.getAttribute('aria-valuemax')).toBe('10');
    const supportBar = screen.getByRole('progressbar', { name: 'Support' });
    expect(supportBar.getAttribute('aria-valuenow')).toBe('0');
    expect(supportBar.getAttribute('aria-valuemax')).toBe('8');

    // "Today's outcomes" donut legend: sent 5, failed 1, waiting 4 -> 50/10/40%.
    const outcomes = screen.getByTestId('dashboard-outcomes-card');
    const legend = within(outcomes).getByRole('list');
    expect(legend.textContent).toContain('5');
    expect(legend.textContent).toContain('50%');
    expect(legend.textContent).toContain('1');
    expect(legend.textContent).toContain('10%');
    expect(legend.textContent).toContain('4');
    expect(legend.textContent).toContain('40%');

    // Fleet health: mean of 90 and 70 is exactly 80.
    const fleetHealth = screen.getByTestId('dashboard-fleet-health');
    const ring = within(fleetHealth).getByRole('img');
    expect(ring.getAttribute('aria-label')).toContain('80');

    // Wallet estimate is an honest estimate, never a promise.
    const walletCard = screen.getByTestId('dashboard-wallet-card');
    expect(walletCard.textContent).toContain('500');
    expect(walletCard.textContent?.toLowerCase()).toContain('estimate');
    expect(walletCard.textContent?.toLowerCase()).not.toContain('guarantee');
  });
});
