// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { TopupRequestForm } from '../components/topup-request-form.js';

/**
 * topup-request-form-idempotency.test.tsx (P26b C2 hardening) - the
 * top-up form must reuse the SAME `Idempotency-Key` across a network-failure
 * retry of the same submission (queue-engineering skill: "duplicate POST
 * returns the original job, creates nothing" only holds if the client sends
 * the same key), and mint a FRESH key for a genuinely new submission after a
 * successful create. Bug found and fixed in this hardening pass: the form
 * previously called `crypto.randomUUID()` fresh on every submit.
 */

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function fillAndSubmit(): void {
  fireEvent.change(screen.getByTestId('topup-amount-input'), { target: { value: '100.00' } });
  fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR12345' } });
  fireEvent.click(screen.getByTestId('topup-form-submit'));
}

function renderForm(fetchMock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <TopupRequestForm onSubmitted={() => undefined} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

function captureHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (init?.headers) {
    for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

describe('TopupRequestForm idempotency key', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reuses the same Idempotency-Key when a retry follows a network failure', async () => {
    const requests: RecordedRequest[] = [];
    let call = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      requests.push({ method, url, headers: captureHeaders(init) });
      call += 1;
      if (call === 1) {
        // Transport-level failure - not an ApiError, exactly the retryable case.
        throw new TypeError('Failed to fetch');
      }
      return new Response(
        JSON.stringify({
          data: {
            id: 'topup-1',
            amountMinor: '10000',
            status: 'pending',
            createdAt: '2026-09-08T00:00:00.000Z',
          },
          meta: { requestId: 'r1' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderForm(fetchMock);

    fillAndSubmit();
    await waitFor(() => expect(requests).toHaveLength(1));

    // Retry the same submission (values unchanged) after the failure.
    fillAndSubmit();
    await waitFor(() => expect(requests).toHaveLength(2));

    const firstKey = requests[0]?.headers['idempotency-key'];
    const secondKey = requests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBe(firstKey);
  });

  it('mints a fresh Idempotency-Key for a new submission after a successful create', async () => {
    const requests: RecordedRequest[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      requests.push({ method, url, headers: captureHeaders(init) });
      return new Response(
        JSON.stringify({
          data: {
            id: `topup-${String(requests.length)}`,
            amountMinor: '10000',
            status: 'pending',
            createdAt: '2026-09-08T00:00:00.000Z',
          },
          meta: { requestId: 'r1' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderForm(fetchMock);

    fillAndSubmit();
    await waitFor(() => expect(requests).toHaveLength(1));

    // Second, distinct submission (form remounts state via a fresh utr) mints its own key.
    fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR99999' } });
    fireEvent.click(screen.getByTestId('topup-form-submit'));
    await waitFor(() => expect(requests).toHaveLength(2));

    const firstKey = requests[0]?.headers['idempotency-key'];
    const secondKey = requests[1]?.headers['idempotency-key'];
    expect(firstKey).toBeTruthy();
    expect(secondKey).toBeTruthy();
    expect(secondKey).not.toBe(firstKey);
  });
});
