// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { BROADCAST_DISCLOSURE } from '@wp/domain';
import { Composer } from '../components/composer.js';
import { BroadcastDetail } from '../components/broadcast-detail.js';
import { invalidateForRealtimeEvent } from '../../../lib/sse-invalidation-map.js';
import {
  stubComposerFetch,
  INSTANCE_ID,
  type RecordedRequest,
} from './__test-support__/stub-composer-fetch.js';

/**
 * panel-proof.test.tsx (P23a Unit U5, phase step 5: the panel proof) - the
 * end-to-end composer -> preflight -> start -> funnel path. Compose and
 * start a broadcast against the SAME fetch stub the composer suite uses
 * (`stub-composer-fetch.ts`), capture the started id, then render
 * `BroadcastDetail` for that id against a second, sequenced detail fetch
 * stub so the funnel is proven to move from `queued` to `sent` both via a
 * refetch (`invalidateQueries`) and via the exact production SSE path
 * (`invalidateForRealtimeEvent` on a `campaign.progress` event).
 */

async function fillBasicForm(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Launch' } });

  const instanceSelect = await screen.findByTestId('composer-instance');
  await waitFor(() => {
    // A plain DOM query, not `getAllByRole`: the value-holder `<select>` is
    // intentionally `aria-hidden` (see composer.tsx) so role-based queries
    // never see it, matching `messages/compose/composer.test.tsx`'s idiom
    // for the same hidden-input pattern.
    expect(instanceSelect.querySelectorAll('option').length).toBeGreaterThan(0);
  });
  fireEvent.change(instanceSelect, { target: { value: INSTANCE_ID } });

  const tagCheckbox = await screen.findByRole('checkbox', { name: /VIP/ });
  fireEvent.click(tagCheckbox);

  fireEvent.change(screen.getByTestId('composer-body'), {
    target: { value: 'Hello there' },
  });
}

interface DetailSequenceOptions {
  campaignId: string;
  responses: Array<{ status: string; queued: number; sent: number }>;
}

function baseCounters(): Record<string, number> {
  return {
    total: 3,
    pending: 0,
    skipped: 0,
    queued: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    cancelled: 0,
    deferred: 0,
    chargedMinor: 90,
  };
}

function stubSequencedDetailFetch(options: DetailSequenceOptions): () => number {
  let callIndex = 0;
  const fetchMock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`/v1/broadcasts/${options.campaignId}`)) {
      const index = Math.min(callIndex, options.responses.length - 1);
      const response = options.responses[index]!;
      callIndex += 1;
      return new Response(
        JSON.stringify({
          data: {
            id: options.campaignId,
            name: 'Launch',
            status: response.status,
            instanceId: INSTANCE_ID,
            priority: 'low',
            audienceCount: 3,
            quoteMinor: 90,
            priceKey: 'default',
            scheduledAt: null,
            snapshotDoneAt: '2026-09-06T00:00:00.000Z',
            expandDoneAt: '2026-09-06T00:00:00.000Z',
            cancelReason: null,
            createdAt: '2026-09-06T00:00:00.000Z',
            updatedAt: '2026-09-06T00:00:00.000Z',
            counters: { ...baseCounters(), queued: response.queued, sent: response.sent },
            disclosure: BROADCAST_DISCLOSURE,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  globalThis.fetch = fetchMock as any;
  return () => callIndex;
}

describe('panel proof: compose -> preflight -> start -> funnel', () => {
  afterEach(() => {
    cleanup();
  });

  it('compose_preflight_start_then_the_funnel_shows_queued_moving_to_sent', async () => {
    const requests: RecordedRequest[] = [];
    stubComposerFetch(requests);
    const composerQueryClient = new QueryClient();

    let startedId: string | null = null;
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={composerQueryClient}>
          <Composer onStarted={(id) => (startedId = id)} />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await fillBasicForm();
    fireEvent.click(screen.getByTestId('composer-review'));
    await screen.findByTestId('preflight-panel');

    const preflightText = document.body.textContent ?? '';
    expect(preflightText).not.toMatch(/faster|boost|speed up/i);

    fireEvent.click(screen.getByText('Start broadcast'));

    await waitFor(() => {
      expect(startedId).not.toBeNull();
    });

    cleanup();

    const campaignId = startedId as unknown as string;
    stubSequencedDetailFetch({
      campaignId,
      responses: [
        { status: 'running', queued: 3, sent: 0 },
        { status: 'running', queued: 0, sent: 3 },
      ],
    });

    const detailQueryClient = new QueryClient();
    const rootRoute = createRootRoute({
      component: () => <BroadcastDetail id={campaignId} />,
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(
      <I18nProvider locale="en">
        <ToastProvider>
          <QueryClientProvider client={detailQueryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ToastProvider>
      </I18nProvider>,
    );

    const queuedRow = await screen.findByTestId('funnel-queued');
    expect(queuedRow.textContent).toContain('3');
    expect(screen.getByTestId('funnel-sent').textContent).toContain('0');
    expect(screen.getByTestId('broadcast-disclosure').textContent).toBe(BROADCAST_DISCLOSURE);

    invalidateForRealtimeEvent(detailQueryClient, {
      type: 'campaign.progress',
      campaignId,
      sent: 3,
      queued: 0,
      failed: 0,
    });

    await waitFor(() => {
      expect(screen.getByTestId('funnel-sent').textContent).toContain('3');
    });
    expect(screen.getByTestId('funnel-queued').textContent).toContain('0');

    const finalText = document.body.textContent ?? '';
    expect(finalText).not.toMatch(/faster|boost|speed up/i);
  });
});
