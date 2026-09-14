// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
 * connect-whatsapp-step-limit-or-no-plan.test.tsx (2026-09-08 bug fix) - the
 * onboarding wizard's connect step hits the same `POST /v1/instances` route
 * as the panel's `ConnectSheet`, so a `REGISTERED_LIMIT_REACHED` 409 (a
 * fresh workspace with no plan assigned yet, exactly the QA repro) must
 * show the same three-part no-plan-aware message, gated behind
 * `wizard-connect-whatsapp-limit-gate`, without disturbing the MFA gate.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function meBody(): unknown {
  return {
    data: {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'a@example.com',
        fullName: 'Ada Example',
        emailVerifiedAt: '2026-01-01T00:00:00.000Z',
        mfaEnabledAt: '2026-01-01T00:00:00.000Z',
      },
      client: {
        id: '22222222-2222-4222-8222-222222222222',
        companyName: 'Acme',
        onboardingStep: 'connect_whatsapp',
        status: 'active',
      },
      membership: { role: 'owner' },
    },
    meta: { requestId: 'r1' },
  };
}

function renderStep(): void {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (url === '/v1/auth/me') {
      return Promise.resolve(jsonResponse(meBody()));
    }
    if (url === '/v1/instances' && method === 'POST') {
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              code: 'REGISTERED_LIMIT_REACHED',
              message: 'This plan has reached its registered-instance limit.',
              requestId: 'r2',
            },
          },
          409,
        ),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
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

describe('ConnectWhatsappStep - REGISTERED_LIMIT_REACHED (no plan or limit used up)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('renders_the_limit_gate_with_the_no_plan_aware_message', async () => {
    setAccessToken('test-token');
    renderStep();

    await waitFor(() => {
      expect(screen.getByTestId('connect-label-input')).not.toBeNull();
    });
    fireEvent.change(screen.getByTestId('connect-label-input'), { target: { value: 'Sales' } });
    fireEvent.click(screen.getByTestId('connect-create-button'));

    const gate = await screen.findByTestId('wizard-connect-whatsapp-limit-gate');
    expect(gate.textContent).toContain('This workspace cannot add a number yet');
    expect(gate.textContent).toContain('Your workspace has no plan assigned');
    expect(document.body.textContent ?? '').not.toContain('Something went wrong');
  });
});
