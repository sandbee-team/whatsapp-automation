// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider } from '@wp/ui';
import { setAccessToken } from '../../../../lib/api-client.js';
import { ConnectWhatsappStep } from '../connect-whatsapp-step.js';

/**
 * connect-whatsapp-step.test.tsx (P26b, security follow-up) - a
 * `mfaEnabledAt: null` `/v1/auth/me` renders the "secure your account
 * first" gate ABOVE the connect form (never instead of it being reachable
 * at all - the wizard step id and create button must both stay findable
 * once two-factor IS set up); `mfaEnabledAt` set renders the connect form
 * with no gate.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function meBody(mfaEnabledAt: string | null): unknown {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'a@example.com',
      fullName: 'Ada Example',
      emailVerifiedAt: '2026-01-01T00:00:00.000Z',
      mfaEnabledAt,
    },
    client: {
      id: '22222222-2222-4222-8222-222222222222',
      companyName: 'Acme',
      onboardingStep: 'connect_whatsapp',
      status: 'active',
    },
    membership: { role: 'owner' },
  };
}

function renderStep(mfaEnabledAt: string | null): void {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/v1/auth/me') {
      return Promise.resolve(jsonResponse(meBody(mfaEnabledAt)));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const rootRoute = createRootRoute({
    component: () => <ConnectWhatsappStep isCurrentStep />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/onboarding'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('ConnectWhatsappStep - two-factor gate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('mfa_not_enabled_shows_the_secure_account_card_above_the_connect_form', async () => {
    setAccessToken('test-token');
    renderStep(null);

    await screen.findByTestId('wizard-connect-whatsapp-mfa-gate');
    expect(screen.getByTestId('wizard-connect-whatsapp-mfa-setup-button')).not.toBeNull();
    // The wizard step root and its create button both stay findable.
    expect(screen.getByTestId('wizard-connect-whatsapp')).not.toBeNull();
    expect(screen.getByTestId('connect-create-button')).not.toBeNull();
  });

  it('mfa_enabled_renders_the_connect_form_with_no_gate', async () => {
    setAccessToken('test-token');
    renderStep('2026-01-01T00:00:00.000Z');

    await waitFor(() => {
      expect(screen.getByTestId('connect-create-button')).not.toBeNull();
    });
    expect(screen.queryByTestId('wizard-connect-whatsapp-mfa-gate')).toBeNull();
  });
});
