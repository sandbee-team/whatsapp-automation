// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { InstancesScreen } from '../components/instances-screen.js';
import type { InstanceCardResult } from '../api.js';

/**
 * instances-screen.test.tsx (2026-09-08 panel refresh, unit S4) - stubbed
 * `fetch` for `/v1/queue-status` and each instance's `/v1/instances/:id/card`
 * (same `stubFetch` idiom as `use-instance-list.test.tsx` /
 * `dashboard-page.test.tsx`). Covers the summary strip counts for a 3-item
 * list with one needs-action and one parked number.
 */

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function card(overrides: Partial<InstanceCardResult>): InstanceCardResult {
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

function stubThreeItemFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/v1/queue-status')) {
        return json({
          instances: [
            { instanceId: ID_A, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
            { instanceId: ID_B, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
            { instanceId: ID_C, waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
          ],
          workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
        });
      }
      if (url.includes(`/v1/instances/${ID_A}/card`)) {
        return json(card({ instanceId: ID_A, label: 'Sales', healthState: 'connected' }));
      }
      if (url.includes(`/v1/instances/${ID_B}/card`)) {
        return json(
          card({
            instanceId: ID_B,
            label: 'Support',
            healthState: 'degraded',
            needsUserAction: true,
            userActionReason: 'RECONNECT_FAILED',
          }),
        );
      }
      if (url.includes(`/v1/instances/${ID_C}/card`)) {
        return json(
          card({ instanceId: ID_C, label: 'Marketing', healthState: 'paused', parked: true }),
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function renderScreen(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: InstancesScreen });
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

describe('InstancesScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('the summary strip counts one connected, one needs-attention and one parked out of three', async () => {
    stubThreeItemFetch();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('instances-numbers-grid')).toBeTruthy();
    });

    const strip = screen.getByTestId('instances-summary-strip');
    expect(strip).toBeTruthy();

    const connected = screen.getByTestId('instances-summary-connected');
    expect(connected.querySelector('[data-target]')?.getAttribute('data-target')).toBe('1');

    const needsAttention = screen.getByTestId('instances-summary-needs-attention');
    expect(needsAttention.querySelector('[data-target]')?.getAttribute('data-target')).toBe('1');

    const parked = screen.getByTestId('instances-summary-parked');
    expect(parked.querySelector('[data-target]')?.getAttribute('data-target')).toBe('1');
  });

  it('renders every card with its progress bars once loaded', async () => {
    stubThreeItemFetch();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('instances-numbers-grid')).toBeTruthy();
    });

    const bars = await screen.findAllByRole('progressbar');
    // Two bars per card x three cards.
    expect(bars).toHaveLength(6);
  });
});
