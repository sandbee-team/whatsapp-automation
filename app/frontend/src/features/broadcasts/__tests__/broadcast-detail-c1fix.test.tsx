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
import { BroadcastDetail } from '../components/broadcast-detail.js';
import {
  stubBroadcastDetailFetch,
  BROADCAST_ID,
  type RecordedRequest,
} from './__test-support__/stub-broadcast-fetch.js';

/**
 * broadcast-detail-c1fix.test.tsx (P23a C1 fix round MAJOR 2 + MINOR 7) - a
 * sibling of `broadcast-list.test.tsx` (kept separate to stay clear of the
 * `max-lines: 300` cap): the failed pause/resume/cancel action's alert +
 * dialog-stays-open contract, and the instance label resolution on the
 * detail header.
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

describe('BroadcastDetail action errors', () => {
  afterEach(() => {
    cleanup();
  });

  it('a_failed_cancel_shows_an_alert_and_keeps_the_dialog_open', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, {
      status: 'running',
      failNextCancelWith: { status: 409, code: 'CONFLICT' },
    });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel broadcast' });
    fireEvent.click(cancelButton);

    const dialog = await screen.findByRole('dialog');
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmButton);

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toBe('This broadcast has already changed. Reload and try again.');

    // The dialog is still present so the user can retry or back out - never
    // silently closed and never left with no explanation.
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();

    const cancelRequests = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    );
    expect(cancelRequests).toHaveLength(1);
  });

  it('a_generic_500_on_cancel_shows_the_generic_error_message', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, {
      status: 'running',
      failNextCancelWith: { status: 500, code: 'INTERNAL' },
    });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel broadcast' });
    fireEvent.click(cancelButton);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toBe('Something went wrong. Nothing was sent.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('BroadcastDetail action idempotency key reuse', () => {
  afterEach(() => {
    cleanup();
  });

  it('a_retried_cancel_after_a_failed_attempt_reuses_the_same_idempotency_key', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, {
      status: 'running',
      failNextCancelWith: { status: 500, code: 'INTERNAL' },
    });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel broadcast' });
    fireEvent.click(cancelButton);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => screen.getByRole('alert'));

    // Retry: same dialog, same intent, click Confirm again.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const cancelRequests = requests.filter(
        (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
      );
      expect(cancelRequests).toHaveLength(2);
    });

    const cancelRequests = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    );
    const firstKey = cancelRequests[0]?.headers['idempotency-key'];
    const secondKey = cancelRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('a_new_action_intent_after_a_terminal_4xx_mints_a_fresh_idempotency_key', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, {
      status: 'running',
      failNextCancelWith: { status: 409, code: 'CONFLICT' },
    });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel broadcast' });
    fireEvent.click(cancelButton);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => screen.getByRole('alert'));

    // A terminal 4xx clears the key - the user's next confirm click for this
    // SAME dialog session is treated as a fresh intent and mints a new key
    // (the previous attempt's 409 means the world moved on; blindly reusing
    // that key would be wrong).
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      const cancelRequests = requests.filter(
        (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
      );
      expect(cancelRequests).toHaveLength(2);
    });

    const cancelRequests = requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/cancel'),
    );
    const firstKey = cancelRequests[0]?.headers['idempotency-key'];
    const secondKey = cancelRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });
});

describe('BroadcastDetail instance label', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows_the_resolved_instance_label_instead_of_the_raw_uuid', async () => {
    const requests: RecordedRequest[] = [];
    stubBroadcastDetailFetch(requests, { status: 'running', instanceCardLabel: 'Sales' });

    renderWithRouter(() => <BroadcastDetail id={BROADCAST_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Sending from Sales')).toBeTruthy();
    });
  });
});
