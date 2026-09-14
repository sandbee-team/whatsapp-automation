// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { NotificationBell } from '../components/notification-bell.js';

/**
 * notification-bell-mark-read-failure.test.tsx (P26b C2 hardening) - the
 * bell's mark-read mutation had no `onError` at all: a failed mark-read was
 * a silent no-op (no rollback needed since nothing is optimistic, but the
 * user was never told the click did nothing). Bug fixed in this hardening
 * pass by adding a failure toast.
 */

function listResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ data: { items, nextCursor: null } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unreadCountResponse(count: number): Response {
  return new Response(JSON.stringify({ data: { count } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(markReadFails: boolean, options: { markAllReadFails?: boolean } = {}): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('/v1/notifications/unread-count')) {
      return unreadCountResponse(1);
    }
    if (url.includes('/v1/notifications/read-all')) {
      if (options.markAllReadFails) {
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r1' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: { count: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/notifications') && method === 'GET') {
      return listResponse([
        { id: 'n1', title: 'Instance paused', createdAt: '2026-09-08T00:00:00.000Z', readAt: null },
      ]);
    }
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
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderBell(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ToastProvider dismissLabel="Dismiss">
          <NotificationBell />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('NotificationBell mark-read failure', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a failure toast when mark-read fails, and the item stays unread', async () => {
    stubFetch(true);
    renderBell();

    fireEvent.click(screen.getByTestId('notification-bell-toggle'));
    const markReadButton = await screen.findByTestId('notification-mark-read-n1');
    fireEvent.click(markReadButton);

    await waitFor(() => {
      expect(screen.getByText('Could not mark this as read. Please try again.')).toBeTruthy();
    });
    // No stale "done" state: the item is still shown as unread (button still present).
    expect(screen.getByTestId('notification-mark-read-n1')).toBeTruthy();
  });

  it('shows no failure toast and clears the unread action on success', async () => {
    stubFetch(false);
    renderBell();

    fireEvent.click(screen.getByTestId('notification-bell-toggle'));
    const markReadButton = await screen.findByTestId('notification-mark-read-n1');
    fireEvent.click(markReadButton);

    await waitFor(() => {
      expect(screen.queryByText('Could not mark this as read. Please try again.')).toBeNull();
    });
  });

  it('shows a failure toast when mark-all-read fails (MINOR-10)', async () => {
    stubFetch(false, { markAllReadFails: true });
    renderBell();

    fireEvent.click(screen.getByTestId('notification-bell-toggle'));
    await screen.findByTestId('notification-mark-read-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    await waitFor(() => {
      expect(screen.getByText('Could not mark all as read. Please try again.')).toBeTruthy();
    });
  });

  it('shows no failure toast when mark-all-read succeeds', async () => {
    stubFetch(false, { markAllReadFails: false });
    renderBell();

    fireEvent.click(screen.getByTestId('notification-bell-toggle'));
    await screen.findByTestId('notification-mark-read-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    await waitFor(() => {
      expect(screen.queryByText('Could not mark all as read. Please try again.')).toBeNull();
    });
  });
});
