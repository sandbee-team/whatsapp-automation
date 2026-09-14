// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { BroadcastList } from '../components/broadcast-list.js';
import { paiseToRupees } from '../../wallet/money.js';
import { BROADCAST_ID, INSTANCE_ID } from './__test-support__/stub-broadcast-fetch.js';

/**
 * broadcast-list-envelope.test.tsx (P23a Unit U5 C-fix) - split out of
 * `broadcast-list.test.tsx` to stay under the 300-line cap (same idiom as
 * `session-worker-discovery-wiring.ts`). Regression for the `GET
 * /v1/broadcasts` envelope shape mismatch that crashed the `/broadcasts`
 * screen into the root error boundary for every tenant: the real wire shape
 * is `data: { items: [...] }` (keyset cursor on `meta.nextCursor`), never a
 * bare array - see `listBroadcastsOutputSchema`'s own doc comment.
 */

function renderWithRouter(component: () => React.JSX.Element): void {
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
}

function stubListEnvelope(items: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { items }, meta: { requestId: 'r' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: BROADCAST_ID,
    name: 'Launch one',
    status: 'running',
    instanceId: INSTANCE_ID,
    priority: 'low',
    audienceCount: 10,
    quoteMinor: null,
    priceKey: null,
    scheduledAt: null,
    snapshotDoneAt: null,
    expandDoneAt: null,
    cancelReason: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('list response envelope shape (regression: data.items, not a bare array)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the empty state with zero items, a row with a null quote as an em dash, and the rupee string for a numeric quote - never the root error boundary', async () => {
    stubListEnvelope([]);
    renderWithRouter(BroadcastList);
    await screen.findByText('No broadcasts yet.');
    expect(screen.queryAllByTestId(/^broadcast-row-/)).toHaveLength(0);
    cleanup();

    stubListEnvelope([summary({ quoteMinor: null })]);
    renderWithRouter(BroadcastList);
    const row = await screen.findByTestId(`broadcast-row-${BROADCAST_ID}`);
    expect(row.textContent).toBe('Launch one');
    expect(await screen.findByText('—')).toBeTruthy();
    cleanup();

    stubListEnvelope([summary({ quoteMinor: 300, priceKey: 'default' })]);
    renderWithRouter(BroadcastList);
    await screen.findByTestId(`broadcast-row-${BROADCAST_ID}`);
    expect(await screen.findByText(paiseToRupees(300))).toBeTruthy();
  });
});
