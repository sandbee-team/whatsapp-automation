// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { GroupsScreen } from '../components/groups-screen.js';

/**
 * groups-screen.test.tsx (P26b U5) - the `/groups` route's instance picker
 * (fed by `useInstanceList()`, THE shared instance list) and its "no
 * instance chosen yet" empty state. Same raw-`fetch`-stub idiom as
 * `group-list.test.tsx` - no MSW.
 */
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
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
    if (url.includes(`/v1/instances/${INSTANCE_ID}/card`)) {
      return jsonResponse({
        instanceId: INSTANCE_ID,
        label: 'Sales team',
        warmupTier: 3,
        effDailyCap: 500,
        todaySent: 10,
      });
    }
    if (url.includes(`/v1/instances/${INSTANCE_ID}/groups`)) {
      return jsonResponse({
        items: [],
        nextCursor: undefined,
        budget: { trackedDevicesEnabledTotal: 0, max: 2000 },
        groupCap: {
          warmupTier: 3,
          healthBand: 'healthy',
          effGroupDailyCap: 50,
          sentToday: 0,
          remainingToday: 50,
        },
        sync: { lastSyncedAt: null, nextSyncAfter: null, requestedAt: null },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderScreen(): void {
  stubFetch();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <ToastProvider dismissLabel="Dismiss">
        <QueryClientProvider client={queryClient}>
          <GroupsScreen />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('GroupsScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the no-instance empty state before any instance is picked', async () => {
    renderScreen();
    await screen.findByTestId('groups-no-instance');
  });

  it('picking an instance from the shared instance list renders the group list', async () => {
    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('groups-instance-picker')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('combobox', { name: 'Number' }));
    const option = await screen.findByRole('option', { name: 'Sales team' });
    fireEvent.click(option);

    await screen.findByTestId('groups-screen');
    expect(screen.queryByTestId('groups-no-instance')).toBeNull();
  });
});
