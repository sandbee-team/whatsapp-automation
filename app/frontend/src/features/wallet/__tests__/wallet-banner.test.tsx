// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, type Locale } from '@wp/ui';
import { BANNED_CLAIMS } from '@wp/domain';
import { WalletBanner } from '../components/wallet-banner.js';

/**
 * wallet-banner.test.tsx (P19 Unit U5, step 7) - the empty-wallet banner
 * proof: states that queued messages are preserved (contains the live
 * waiting count) in both `en`/`hi`, and contains no banned claim/
 * restriction wording. Same `it.each<Locale>` + `I18nProvider` shape as
 * `features/dashboard/__tests__/empty-dashboard.test.tsx`.
 */

const QUEUED_COUNT = 7;

function stubWalletAndQueueStatusFetch(): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/wallet')) {
      return new Response(
        JSON.stringify({
          data: {
            balanceMinor: 0,
            state: 'empty',
            lowBalanceThresholdMinor: 500,
            maxRateMinor: 100,
            estimatedMessagesRemaining: 0,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/queue-status')) {
      return new Response(
        JSON.stringify({
          data: {
            instances: [],
            workspace: {
              waiting: QUEUED_COUNT,
              sentToday: 0,
              failedToday: 0,
              // PAISE, decimal string wire type (queueStatusWorkspaceSchema) -
              // never a JSON number, see paiseAmountSchema's own doc comment.
              spentTodayMinor: '0',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function renderBanner(locale: Locale): void {
  const queryClient = new QueryClient();
  render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={queryClient}>
        <WalletBanner />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('WalletBanner', () => {
  beforeEach(() => {
    stubWalletAndQueueStatusFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each<Locale>(['en', 'hi'])(
    'the_empty_wallet_banner_states_that_queued_messages_are_preserved (%s)',
    async (locale) => {
      renderBanner(locale);

      const banner = await screen.findByTestId('wallet-banner');
      const text = banner.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(String(QUEUED_COUNT));

      const lowerText = text.toLowerCase();
      // The extra restriction/speed wording is DERIVED, never restated as
      // literals: `scripts/check-copy.ts` scans this file's own source text
      // for any `BANNED_CLAIMS` substring, so spelling one out here (even to
      // assert its ABSENCE) trips the guard on the test itself. Only
      // `packages/domain/src/copy/banned-claims.ts` is exempt from that scan.
      // `guaranteed`/`instant` are reached via the BANNED_CLAIMS entries that
      // already contain them; `RESTRICTION_STEMS` holds only the two neutral
      // stems no banned phrase contains as a contiguous literal.
      const RESTRICTION_STEMS = ['guarantee', 'instantly'];
      for (const stem of [...BANNED_CLAIMS, ...RESTRICTION_STEMS]) {
        expect(lowerText).not.toContain(stem.toLowerCase());
      }
    },
  );
});
