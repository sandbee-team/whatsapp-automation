// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { RecentActivityCard } from '../components/recent-activity-card.js';

/**
 * recent-activity-card-mark-read-failure.test.tsx (P26b C2 hardening) - the
 * card's own doc comment claimed an "optimistic" `readAt` flip that the code
 * never performed, and its mutation had no `onError` handler: a failed
 * mark-read was a silent no-op with no failure toast. Both are fixed in this
 * hardening pass.
 */

function listResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ data: { items, nextCursor: null } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(markReadFails: boolean): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/notifications/n1/read')) {
      if (markReadFails) {
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r1' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: { id: 'n1' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/notifications')) {
      return listResponse([
        { id: 'n1', title: 'Instance paused', createdAt: '2026-09-08T00:00:00.000Z', readAt: null },
      ]);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderCard(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ToastProvider dismissLabel="Dismiss">
          <RecentActivityCard />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('RecentActivityCard mark-read failure', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a failure toast and no stale "done" state when mark-read fails', async () => {
    stubFetch(true);
    renderCard();

    const markReadButton = await screen.findByTestId('recent-activity-mark-read-n1');
    fireEvent.click(markReadButton);

    await waitFor(() => {
      expect(screen.getByText('Could not mark this as read. Please try again.')).toBeTruthy();
    });
    // The row is never rewritten ahead of the server response (no optimism):
    // the item remains present and clickable, never removed/flipped.
    expect(screen.getByTestId('recent-activity-mark-read-n1')).toBeTruthy();
  });

  it('shows no failure toast on a successful mark-read', async () => {
    stubFetch(false);
    renderCard();

    const markReadButton = await screen.findByTestId('recent-activity-mark-read-n1');
    fireEvent.click(markReadButton);

    await waitFor(() => {
      expect(screen.queryByText('Could not mark this as read. Please try again.')).toBeNull();
    });
  });
});
