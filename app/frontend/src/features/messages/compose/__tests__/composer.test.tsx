// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { COMPOSER_QUEUED_COPY } from '@wp/domain';
import { Composer } from '../Composer.js';
import { setAccessToken } from '../../../../lib/api-client.js';
import { dispatchRealtimeEvent } from '../../../../lib/sse-event-registry.js';

/**
 * composer.test.tsx (P11 U6a) - the two mandatory phase-table cases:
 * (1) a queued message never renders a tick, only the queued clock, until
 *     the SSE `message.job.status_changed` event reports `status: 'sent'`
 *     for THIS job's `jobPublicId` (no optimistic tick on submit);
 * (2) a retried submission (double-click / network retry) reuses the SAME
 *     `Idempotency-Key` header value - one key, one job, never a fresh key
 *     per HTTP attempt.
 *
 * Network is mocked at `global.fetch` (never a running backend, never a
 * raw fetch from the component itself - `apiFetch` is the ONE network
 * seam, exactly as `api-client.test.ts` mocks it).
 */

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '+919876543210';

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderComposer(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <Composer />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function fillForm(): void {
  fireEvent.change(screen.getByTestId('compose-account-input'), {
    target: { value: INSTANCE_ID },
  });
  fireEvent.change(screen.getByTestId('compose-recipient-input'), {
    target: { value: RECIPIENT },
  });
  fireEvent.change(screen.getByTestId('compose-body-input'), {
    target: { value: 'hello there' },
  });
}

describe('Composer', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('a_queued_message_never_renders_as_sent', async () => {
    // A fresh `Response` per call: `AccountPicker`'s `useInstanceList` issues
    // its own `GET /v1/queue-status` alongside the send, and a `Response`
    // body can only be read once - a single shared mock instance (as
    // `mockResolvedValue` would give) breaks the SECOND caller to read it.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/queue-status')) {
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      return Promise.resolve(
        jsonResponse({ data: { id: 'job-public-id-1', status: 'queued' } }, 201),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();
    fireEvent.click(screen.getByTestId('compose-send-button'));

    await waitFor(() => {
      expect(screen.getByTestId('compose-status').textContent).toContain(COMPOSER_QUEUED_COPY);
    });
    // Queued clock, never a tick, immediately after the 201 response.
    expect(screen.queryByTestId('compose-status-tick')).toBeNull();
    expect(screen.getByTestId('compose-status-clock')).not.toBeNull();

    // The SSE event for THIS job flips it to sent.
    dispatchRealtimeEvent({
      type: 'message.job.status_changed',
      jobPublicId: 'job-public-id-1',
      instanceId: INSTANCE_ID,
      status: 'sent',
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-status-tick')).not.toBeNull();
    });
    expect(screen.queryByTestId('compose-status-clock')).toBeNull();
  });

  it('a_retried_submission_reuses_the_same_idempotency_key', async () => {
    const idempotencyKeysSeen: string[] = [];
    let callCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/v1/messages')) {
        callCount += 1;
        const key = (init?.headers as Record<string, string> | undefined)?.['Idempotency-Key'];
        if (key) idempotencyKeysSeen.push(key);
        // First attempt fails as a transient network error; the retry succeeds.
        if (callCount === 1) {
          return Promise.reject(new TypeError('network error (simulated)'));
        }
        return Promise.resolve(
          jsonResponse({ data: { id: 'job-public-id-2', status: 'queued' } }, 201),
        );
      }
      if (url.startsWith('/v1/queue-status')) {
        // The composer's number picker (`useInstanceList`) reads this list;
        // an empty workspace is a valid, honestly-rendered state here.
        return Promise.resolve(jsonResponse({ data: { instances: [] } }, 200));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderComposer();
    fillForm();

    const sendButton = screen.getByTestId('compose-send-button');
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(callCount).toBe(1);
    });

    // Retry the SAME submission (e.g. a double-click / retry-after-failure) -
    // must reuse the key minted on the first attempt, never mint a new one.
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(callCount).toBe(2);
    });

    expect(idempotencyKeysSeen).toHaveLength(2);
    expect(idempotencyKeysSeen[0]).toBe(idempotencyKeysSeen[1]);
  });
});
