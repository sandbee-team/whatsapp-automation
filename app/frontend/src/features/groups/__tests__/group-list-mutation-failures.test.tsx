// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { GroupList } from '../components/group-list.js';
import {
  stubGroupsFetch,
  groupFixture,
  GROUP_ID,
  INSTANCE_ID,
  type RecordedRequest,
} from '../__test-support__/stub-groups-fetch.js';

/**
 * group-list-mutation-failures.test.tsx (P26b C1 fix round) - split out of
 * `group-list.test.tsx` (same `max-lines: 300` split idiom as
 * `stub-broadcast-fetch.ts`/`stub-composer-fetch.ts`): the per-(group,
 * action) Idempotency-Key retry-reuse contract plus failure toasts on every
 * mutation (sync, toggle-send off, enable, leave).
 */

function renderWithProviders(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <ToastProvider dismissLabel="Dismiss">
        <QueryClientProvider client={queryClient}>
          <GroupList instanceId={INSTANCE_ID} />
        </QueryClientProvider>
      </ToastProvider>
    </I18nProvider>,
  );
  return queryClient;
}

/**
 * Wraps `globalThis.fetch` so the FIRST request matching `method` + a URL
 * ending in `pathSuffix` returns a 500, and every OTHER request (including
 * the retry) falls through to whatever fetch was already installed (the
 * `stubGroupsFetch` mock) - recording every matching request itself so an
 * intercepted (never-forwarded) failure response is still visible to the
 * test's own assertions on `requests`.
 */
function failFirstRequestTo(
  requests: RecordedRequest[],
  method: string,
  pathSuffix: string,
): { callCount: () => number } {
  let count = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === method && url.endsWith(pathSuffix)) {
      count += 1;
      const headers: Record<string, string> = {};
      if (init.headers) {
        for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
          headers[key.toLowerCase()] = value;
        }
      }
      requests.push({ method, url, headers, body: undefined });
      if (count === 1) {
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
    return originalFetch(input, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  return { callCount: () => count };
}

/** Same shape as `failFirstRequestTo` but every matching request always fails - for the plain failure-toast tests. */
function failEveryRequestTo(method: string, pathSuffix: string): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === method && url.endsWith(pathSuffix)) {
      return new Response(
        JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('GroupList mutation failures', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('onSyncClick_reuses_the_same_idempotency_key_on_retry_after_a_failure', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    const sync = failFirstRequestTo(requests, 'POST', '/groups/sync');

    renderWithProviders();

    const syncButton = await screen.findByTestId('groups-sync-button');
    fireEvent.click(syncButton);
    await waitFor(() => expect(sync.callCount()).toBe(1));

    fireEvent.click(syncButton);
    await waitFor(() => expect(sync.callCount()).toBe(2));

    const syncRequests = requests.filter((request) => request.url.endsWith('/groups/sync'));
    const firstKey = syncRequests[0]?.headers['idempotency-key'];
    const secondKey = syncRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('onSyncClick_shows_a_failure_toast_on_a_non_rate_limit_error', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    failEveryRequestTo('POST', '/groups/sync');

    renderWithProviders();
    const syncButton = await screen.findByTestId('groups-sync-button');
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    });
  });

  it('onToggleSend_off_reuses_the_same_idempotency_key_on_retry_after_a_failure', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { groups: [groupFixture(GROUP_ID, { sendEnabled: true })] });
    const patch = failFirstRequestTo(requests, 'PATCH', '/send-enabled');

    renderWithProviders();
    const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
    fireEvent.click(toggle);
    await waitFor(() => expect(patch.callCount()).toBe(1));

    // Retry the same off-toggle after the failure toast.
    fireEvent.click(screen.getByTestId(`group-row-toggle-${GROUP_ID}`));
    await waitFor(() => expect(patch.callCount()).toBe(2));

    const patchRequests = requests.filter((request) => request.url.endsWith('/send-enabled'));
    const firstKey = patchRequests[0]?.headers['idempotency-key'];
    const secondKey = patchRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('onToggleSend_off_shows_a_failure_toast_on_error', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests, { groups: [groupFixture(GROUP_ID, { sendEnabled: true })] });
    failEveryRequestTo('PATCH', '/send-enabled');

    renderWithProviders();
    const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    });
  });

  it('confirmEnable_reuses_the_same_idempotency_key_on_retry_after_a_failure', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    const patch = failFirstRequestTo(requests, 'PATCH', '/send-enabled');

    renderWithProviders();
    const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId('enable-send-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(patch.callCount()).toBe(1));

    // Dialog stays open on a non-GROUP_NOT_SENDABLE failure - retry via Confirm again.
    fireEvent.click(
      within(screen.getByTestId('enable-send-dialog')).getByRole('button', {
        name: 'Turn on',
      }),
    );
    await waitFor(() => expect(patch.callCount()).toBe(2));

    const patchRequests = requests.filter((request) => request.url.endsWith('/send-enabled'));
    const firstKey = patchRequests[0]?.headers['idempotency-key'];
    const secondKey = patchRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('confirmEnable_keeps_the_dialog_open_with_a_visible_message_on_a_non_GROUP_NOT_SENDABLE_error', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    failEveryRequestTo('PATCH', '/send-enabled');

    renderWithProviders();
    const toggle = await screen.findByTestId(`group-row-toggle-${GROUP_ID}`);
    fireEvent.click(toggle);
    const dialog = await screen.findByTestId('enable-send-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));

    await waitFor(() => {
      expect(within(screen.getByTestId('enable-send-dialog')).getByRole('alert')).toBeTruthy();
    });
    expect(screen.getByTestId('enable-send-dialog')).toBeTruthy();
  });

  it('confirmLeave_reuses_the_same_idempotency_key_on_retry_after_a_failure', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    const leave = failFirstRequestTo(requests, 'POST', '/leave');

    renderWithProviders();
    const leaveButton = await screen.findByTestId(`group-row-leave-${GROUP_ID}`);
    fireEvent.click(leaveButton);
    const dialog = await screen.findByTestId('leave-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));
    await waitFor(() => expect(leave.callCount()).toBe(1));

    fireEvent.click(
      within(screen.getByTestId('leave-dialog')).getByRole('button', { name: 'Leave group' }),
    );
    await waitFor(() => expect(leave.callCount()).toBe(2));

    const leaveRequests = requests.filter((request) => request.url.endsWith('/leave'));
    const firstKey = leaveRequests[0]?.headers['idempotency-key'];
    const secondKey = leaveRequests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('confirmLeave_shows_a_failure_toast_on_error', async () => {
    const requests: RecordedRequest[] = [];
    stubGroupsFetch(requests);
    failEveryRequestTo('POST', '/leave');

    renderWithProviders();
    const leaveButton = await screen.findByTestId(`group-row-leave-${GROUP_ID}`);
    fireEvent.click(leaveButton);
    const dialog = await screen.findByTestId('leave-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leave group' }));

    await waitFor(() => {
      expect(screen.getByText('Something went wrong. Please try again.')).toBeTruthy();
    });
  });
});
