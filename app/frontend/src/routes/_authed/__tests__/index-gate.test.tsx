// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import type { OnboardingStep } from '@wp/contracts';
import { AppI18nProvider } from '../../../providers/i18n-provider.js';
import { ThemeProvider } from '../../../providers/theme-provider.js';
import { setAccessToken } from '../../../lib/api-client.js';
import * as apiClient from '../../../lib/api-client.js';
import { routeTree } from '../../../routeTree.gen.js';

/**
 * index-gate.test.tsx (P26b U3) - the dashboard `beforeLoad` gate: any
 * `onboardingStep` BEFORE `connect_whatsapp` in `onboardingStepSchema`'s own
 * declared order redirects to `/onboarding`; `connect_whatsapp`, `send_test`
 * and `done` all render the dashboard. Drives the REAL route tree (same
 * idiom as `routes/__tests__/authed-guard.test.tsx`), stubbing only
 * `ensureSession`/`me`/`fetch` - never the router itself.
 */

function stubAuthed(): void {
  setAccessToken('token');
  vi.spyOn(apiClient, 'ensureSession').mockResolvedValue(true);
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetchForStep(step: OnboardingStep): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/auth/me')) {
      return jsonResponse({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'a@example.com',
          fullName: 'Ada Example',
          emailVerifiedAt: null,
          mfaEnabledAt: null,
        },
        client: {
          id: '22222222-2222-4222-8222-222222222222',
          companyName: 'Acme',
          onboardingStep: step,
          status: 'active',
        },
        membership: { role: 'owner' },
      });
    }
    if (url.includes('/v1/onboarding')) {
      return jsonResponse({ step });
    }
    if (url.includes('/v1/dashboard/summary')) {
      return jsonResponse({ connectedNumbers: 0, queued: 0, sent: 0 });
    }
    if (url.includes('/v1/queue-status')) {
      return jsonResponse({
        instances: [],
        workspace: { waiting: 0, sentToday: 0, failedToday: 0, spentTodayMinor: '0' },
      });
    }
    if (url.includes('/v1/wallet')) {
      return jsonResponse({
        balanceMinor: 0,
        state: 'active',
        lowBalanceThresholdMinor: 500,
        maxRateMinor: 100,
        estimatedMessagesRemaining: 0,
      });
    }
    if (url.includes('/v1/notifications')) {
      return jsonResponse({ items: [], nextCursor: null });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** A fresh client per render: the shared singleton leaked state across it.each cases under load. */
function freshQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderAtRoot() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <AppI18nProvider>
      <ThemeProvider>
        <QueryClientProvider client={freshQueryClient()}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </AppI18nProvider>,
  );
  return router;
}

describe('/ dashboard onboarding gate', () => {
  beforeEach(() => {
    stubAuthed();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it.each<OnboardingStep>([
    'verify_email',
    'choose_timezone',
    'accept_pacing_profile',
    'attest_consent',
  ])('redirects_to_onboarding_when_the_step_is_before_connect_whatsapp (%s)', async (step) => {
    stubFetchForStep(step);
    const router = await renderAtRoot();

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/onboarding');
    });
  });

  it.each<OnboardingStep>(['connect_whatsapp', 'send_test', 'done'])(
    'renders_the_dashboard_when_the_step_is_connect_whatsapp_or_later (%s)',
    async (step) => {
      stubFetchForStep(step);
      const router = await renderAtRoot();

      await vi.waitFor(() => {
        expect(router.state.location.pathname).toBe('/');
      });
      expect(await screen.findByTestId('dashboard-screen')).toBeTruthy();
    },
  );

  // Schema-drift pin (P26b C2 hardening): an `onboardingStep` value the
  // frontend's own `onboardingStepSchema` does not declare (a future step
  // added server-side before the client is redeployed, or a malformed
  // response) must NEVER render the dashboard silently. `indexOf` on an
  // unrecognised value returns -1, which is < any real step's index, so the
  // gate's existing `stepIndex < CONNECT_WHATSAPP_STEP_INDEX` comparison
  // already redirects safely - this test pins that fail-safe behaviour so a
  // future refactor (e.g. switching to a `Set`/allow-list check) cannot
  // silently invert it into "render on unknown".
  it('redirects_to_onboarding_when_the_step_is_not_a_recognised_enum_value_at_all', async () => {
    stubFetchForStep('totally_unknown_future_step' as unknown as OnboardingStep);
    const router = await renderAtRoot();

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/onboarding');
    });
  });
});
