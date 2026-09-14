// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider, type Locale } from '@wp/ui';
import { BROADCAST_DISCLOSURE } from '@wp/domain';
import { BroadcastList } from '../components/broadcast-list.js';
import { BroadcastDetail } from '../components/broadcast-detail.js';
import { broadcastKeys } from '../keys.js';
import {
  stubBroadcastListFetch,
  stubBroadcastDetailFetch,
  BROADCAST_ID,
  BROADCAST_ID_2,
  type RecordedRequest,
} from './__test-support__/stub-broadcast-fetch.js';

/**
 * broadcast-list.test.tsx (P23a Unit U5) - the list screen's keyset
 * pagination, the shared disclosure surface on both list and detail, and the
 * cancel confirm's honest-copy gate. `BroadcastList`/`BroadcastDetail` render
 * `<Link>`s internally, so both render inside a real (memory-history) router,
 * same idiom as `empty-dashboard.test.tsx`.
 */

function renderWithRouter(component: () => React.JSX.Element): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component });
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
  return queryClient;
}

function renderWithRouterLocale(locale: Locale, component: () => React.JSX.Element): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  render(
    <I18nProvider locale={locale}>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

describe('BroadcastList', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('list_paginates_by_cursor_never_offset', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastListFetch(requests, {
      firstNextCursor: 'c2',
      secondNextCursor: undefined,
    });

    renderWithRouter(BroadcastList);

    await screen.findByText('Launch one');

    const loadMore = await screen.findByTestId('broadcasts-load-more');
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('Launch two')).toBeTruthy();
    });

    const listRequests = requests.filter(
      (request) => request.method === 'GET' && request.url.includes('/v1/broadcasts?'),
    );
    expect(listRequests).toHaveLength(2);
    const secondRequest = listRequests[1]!;
    expect(secondRequest.url).toContain('cursor=c2');
    expect(secondRequest.url).not.toContain('offset');

    expect(screen.getByText('Launch one')).toBeTruthy();
    expect(screen.getByText('Launch two')).toBeTruthy();
  });

  it('a_progress_refetch_of_a_later_page_never_duplicates_rows', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastListFetch(requests, {
      firstNextCursor: 'c2',
      secondNextCursor: undefined,
    });

    const queryClient = renderWithRouter(BroadcastList);

    await screen.findByText('Launch one');

    const loadMore = await screen.findByTestId('broadcasts-load-more');
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('Launch two')).toBeTruthy();
    });

    // Same trigger the SSE map uses for `campaign.progress`: invalidate the
    // list key, which prefix-matches every per-cursor query.
    await queryClient.invalidateQueries({ queryKey: broadcastKeys.list() });

    await waitFor(() => {
      const listRequests = requests.filter(
        (request) => request.method === 'GET' && request.url.includes('/v1/broadcasts?'),
      );
      expect(listRequests.length).toBeGreaterThan(2);
    });

    const rows = screen.getAllByTestId(/^broadcast-row-/);
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId(`broadcast-row-${BROADCAST_ID}`)).toBeTruthy();
    expect(screen.getByTestId(`broadcast-row-${BROADCAST_ID_2}`)).toBeTruthy();

    for (const request of requests) {
      expect(request.url).not.toContain('offset');
    }
  });

  it.each<Locale>(['en', 'hi'])(
    'every_list_and_detail_surface_shows_the_broadcast_disclosure (%s)',
    async (locale) => {
      const listRequests: RecordedRequest[] = [];
      stubBroadcastListFetch(listRequests, {});
      renderWithRouterLocale(locale, BroadcastList);
      const listDisclosure = await screen.findByTestId('broadcast-disclosure');
      expect(listDisclosure.textContent).toBe(BROADCAST_DISCLOSURE);
      cleanup();

      const detailRequests: RecordedRequest[] = [];
      stubBroadcastDetailFetch(detailRequests, { status: 'running' });
      renderWithRouterLocale(locale, () => <BroadcastDetail id={BROADCAST_ID} />);
      const detailDisclosure = await screen.findByTestId('broadcast-disclosure');
      expect(detailDisclosure.textContent).toBe(BROADCAST_DISCLOSURE);
    },
  );

  it('cancel_requires_an_explicit_confirm_that_states_sent_messages_are_not_recalled_or_refunded', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, { status: 'running' });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel broadcast' });
    fireEvent.click(cancelButton);

    const cancelPostBeforeConfirm = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    );
    expect(cancelPostBeforeConfirm).toHaveLength(0);

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent ?? '').toContain(
      'Messages already sent are not recalled and are not refunded.',
    );

    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      const cancelRequests = requests.filter(
        (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
      );
      expect(cancelRequests).toHaveLength(1);
    });

    const cancelRequest = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    )!;
    expect(cancelRequest.headers['idempotency-key']).toBeTruthy();
  });
});

describe('BroadcastList row action idempotency key reuse', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a_retried_row_action_after_a_failed_attempt_reuses_the_same_idempotency_key', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastListFetch(requests, {});
    // The list's own stub has no pause/resume/cancel routes - add them here
    // via a wrapping fetch so the row action can actually be exercised.
    const originalFetch = globalThis.fetch;
    let cancelCallCount = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.endsWith('/cancel')) {
        cancelCallCount += 1;
        const headers: Record<string, string> = {};
        if (init.headers) {
          for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
            headers[key.toLowerCase()] = value;
          }
        }
        requests.push({ method: 'POST', url, headers, body: undefined });
        if (cancelCallCount === 1) {
          return new Response(
            JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ data: {}, meta: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input, init);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    renderWithRouter(BroadcastList);
    await screen.findByText('Launch one');

    const menuButtons = screen.getAllByRole('button', { name: 'Actions' });
    fireEvent.click(menuButtons[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const cancelRequests = requests.filter((request) => request.url.endsWith('/cancel'));
      expect(cancelRequests).toHaveLength(1);
    });

    // The dialog stays open on failure - retry via the same Confirm button.
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const cancelRequests = requests.filter((request) => request.url.endsWith('/cancel'));
      expect(cancelRequests).toHaveLength(2);
    });

    const cancelRequests = requests.filter((request) => request.url.endsWith('/cancel'));
    const firstKey = cancelRequests[0]?.headers['idempotency-key'];
    const secondKey = cancelRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });
});

describe('list loading/error/empty states', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('network down'))),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('a_list_fetch_error_shows_an_honest_error_state', async () => {
    renderWithRouter(BroadcastList);
    await screen.findByTestId('broadcasts-error');
  });
});
