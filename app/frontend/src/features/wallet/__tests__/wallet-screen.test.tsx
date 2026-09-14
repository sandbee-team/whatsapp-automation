// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, type Locale } from '@wp/ui';
import { WalletScreen } from '../components/wallet-screen.js';

/**
 * wallet-screen.test.tsx (P26b U5) - the `/wallet` screen's KPI rendering
 * from a stubbed `GET /v1/wallet` + `GET /v1/queue-status`, the top-up
 * history table's data/empty/error states, and a top-up submit that carries
 * an Idempotency-Key header. Same raw-`fetch`-stub idiom as
 * `group-list.test.tsx`/`wallet-banner.test.tsx` - no MSW.
 */

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function walletSummaryResponse(overrides: Partial<Record<string, unknown>> = {}): Response {
  return new Response(
    JSON.stringify({
      data: {
        balanceMinor: 50_000,
        state: 'active',
        lowBalanceThresholdMinor: 5_000,
        maxRateMinor: 100,
        estimatedMessagesRemaining: 500,
        ...overrides,
      },
      meta: { requestId: 'r1' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function queueStatusResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        instances: [],
        workspace: { waiting: 0, sentToday: 3, failedToday: 0, spentTodayMinor: '1250' },
      },
      meta: { requestId: 'r2' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function topupHistoryResponse(items: unknown[]): Response {
  return new Response(JSON.stringify({ data: items, meta: { requestId: 'r3' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubWalletFetch(
  requests: RecordedRequest[],
  options: { historyItems?: unknown[]; historyErrors?: boolean; submitOk?: boolean } = {},
): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    requests.push({ method, url, headers });

    if (url.includes('/v1/wallet/topup-requests') && method === 'POST') {
      if (options.submitOk === false) {
        return new Response(
          JSON.stringify({ error: { code: 'CONFLICT', message: 'duplicate', requestId: 'r4' } }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            id: 'topup-1',
            amountMinor: '10000',
            status: 'pending',
            createdAt: '2026-09-07T00:00:00.000Z',
          },
          meta: { requestId: 'r4' },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/wallet/topup-requests')) {
      if (options.historyErrors) {
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL', message: 'boom', requestId: 'r5' } }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return topupHistoryResponse(options.historyItems ?? []);
    }
    if (url.includes('/v1/wallet')) {
      return walletSummaryResponse();
    }
    if (url.includes('/v1/queue-status')) {
      return queueStatusResponse();
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderScreen(locale: Locale = 'en'): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  stubWalletFetch(requests);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={queryClient}>
        <WalletScreen />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { requests };
}

describe('WalletScreen', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each<Locale>(['en', 'hi'])(
    'renders the balance and spent-today KPIs from stubbed data (%s)',
    async (locale) => {
      renderScreen(locale);

      const screenRoot = await screen.findByTestId('wallet-screen');
      expect(screenRoot).toBeTruthy();

      await waitFor(() => {
        expect(screen.getByTestId('wallet-state-badge')).toBeTruthy();
      });

      // Balance ₹500.00 (50000 paise); spent today ₹12.50 (1250 paise).
      expect(screen.getByText('₹500.00')).toBeTruthy();
      expect(screen.getByText('₹12.50')).toBeTruthy();
    },
  );

  it('shows the honest empty state when there is no top-up history', async () => {
    const requests: RecordedRequest[] = [];
    stubWalletFetch(requests, { historyItems: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={queryClient}>
          <WalletScreen />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByText('No top-up requests yet');
  });

  it('shows the history rows when top-up requests exist', async () => {
    const requests: RecordedRequest[] = [];
    stubWalletFetch(requests, {
      historyItems: [
        {
          id: 't1',
          amountMinor: '150000',
          status: 'approved',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={queryClient}>
          <WalletScreen />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByText('₹1500.00');
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('shows an error state when the top-up history fetch fails', async () => {
    const requests: RecordedRequest[] = [];
    stubWalletFetch(requests, { historyErrors: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <I18nProvider locale="en">
        <QueryClientProvider client={queryClient}>
          <WalletScreen />
        </QueryClientProvider>
      </I18nProvider>,
    );

    await screen.findByText('Something went wrong. Please try again.');
  });

  it('submits a top-up request with an Idempotency-Key header', async () => {
    const { requests } = renderScreen();

    fireEvent.change(screen.getByTestId('topup-amount-input'), { target: { value: '100.00' } });
    fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR12345' } });
    fireEvent.click(screen.getByTestId('topup-form-submit'));

    await waitFor(() => {
      const submitRequest = requests.find(
        (request) => request.method === 'POST' && request.url.includes('/topup-requests'),
      );
      expect(submitRequest).toBeTruthy();
      expect(submitRequest?.headers['idempotency-key']).toBeTruthy();
    });
  });
});
