// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { InstanceDetailPage } from '../components/instance-detail-page.js';

/**
 * instance-detail-page.test.tsx (P26b U3) - the detail page's pause/resume
 * actions: both confirm via `AlertDialog` before calling `park`/`online`,
 * then toast success. Drives a minimal memory router mounted at
 * `/_authed/instances/$id` (the page reads `id` via `useParams`), stubbing
 * only `fetch`.
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function cardResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    instanceId: INSTANCE_ID,
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

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(cardOverrides: Record<string, unknown> = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`/v1/instances/${INSTANCE_ID}/card`)) {
      return jsonResponse(cardResponse(cardOverrides));
    }
    if (url.includes(`/v1/instances/${INSTANCE_ID}/health/why`)) {
      return jsonResponse({ signals: [], timeline: [] });
    }
    if (url.includes('/v1/queue-status')) {
      return jsonResponse({
        instances: [
          {
            instanceId: INSTANCE_ID,
            waiting: 0,
            sentToday: 0,
            failedToday: 0,
            spentTodayMinor: '0',
          },
        ],
        workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
      });
    }
    if (url.includes(`/v1/instances/${INSTANCE_ID}/park`) && init?.method === 'POST') {
      return jsonResponse({ id: INSTANCE_ID, parked: true });
    }
    if (url.includes(`/v1/instances/${INSTANCE_ID}/online`) && init?.method === 'POST') {
      return jsonResponse({ id: INSTANCE_ID, parked: false });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetailPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/instances/$id',
    component: InstanceDetailPage,
  });
  const instancesListRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/instances',
    component: () => <div data-testid="instances-list-screen">Numbers</div>,
  });
  const routeTree = rootRoute.addChildren([detailRoute, instancesListRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/instances/${INSTANCE_ID}`] }),
  });

  render(
    <I18nProvider locale="en">
      <ToastProvider dismissLabel="Close">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );

  return router;
}

describe('InstanceDetailPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('pausing_a_number_confirms_calls_park_and_toasts_success', async () => {
    const fetchMock = stubFetch();
    renderDetailPage();

    fireEvent.click(await screen.findByTestId('instance-detail-pause-button'));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = typeof input === 'string' ? input : (input as URL).toString();
          return url.includes(`/v1/instances/${INSTANCE_ID}/park`) && init?.method === 'POST';
        }),
      ).toBe(true);
    });

    expect(await screen.findByText('Number paused.')).toBeTruthy();
  });

  it('resuming_a_number_confirms_calls_online_and_toasts_success', async () => {
    const fetchMock = stubFetch({ parked: true });
    renderDetailPage();

    fireEvent.click(await screen.findByTestId('instance-detail-resume-button'));

    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          const url = typeof input === 'string' ? input : (input as URL).toString();
          return url.includes(`/v1/instances/${INSTANCE_ID}/online`) && init?.method === 'POST';
        }),
      ).toBe(true);
    });

    expect(await screen.findByText('Number back online.')).toBeTruthy();
  });

  it('needs_action_open_details_opens_the_why_drawer', async () => {
    stubFetch({ needsUserAction: true, userActionReason: 'RELINK_REQUIRED' });
    renderDetailPage();

    fireEvent.click(await screen.findByTestId('needs-action-open-details'));

    expect(await screen.findByText('Why this health score?')).toBeTruthy();
  });

  it('needs_action_reconnect_navigates_to_the_numbers_screen', async () => {
    stubFetch({ needsUserAction: true, userActionReason: 'RECONNECT_FAILED' });
    const router = renderDetailPage();

    fireEvent.click(await screen.findByTestId('needs-action-reconnect'));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/instances');
    });
    expect(await screen.findByTestId('instances-list-screen')).toBeTruthy();
  });
});
