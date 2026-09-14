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
import { I18nProvider, ToastProvider } from '@wp/ui';
import type { MeOutput } from '../api.js';
import { setAccessToken } from '../../../lib/api-client.js';
import { SecurityPage } from '../components/security-page.js';

/**
 * security-page.test.tsx (P26b, security follow-up) - the `/settings/security`
 * screen's carried states: email verified/not verified badge, two-factor
 * enabled/not-set-up (with the honest "not available yet" re-enrolment text
 * once enabled - core invariant 6), and the presence of the real
 * change-password form landed by P28 Unit U7 (its own behaviour is covered
 * by `security-password.test.tsx`). `ToastProvider` is mounted here because
 * the real `_authed` layout mounts one for every authed route.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function meBody(overrides: Partial<MeOutput['user']> = {}): MeOutput {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'a@example.com',
      fullName: 'Ada Example',
      emailVerifiedAt: null,
      mfaEnabledAt: null,
      ...overrides,
    },
    client: {
      id: '22222222-2222-4222-8222-222222222222',
      companyName: 'Acme',
      onboardingStep: 'done',
      status: 'active',
    },
    membership: { role: 'owner' },
  };
}

function renderPage(me: MeOutput) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/v1/auth/me') return Promise.resolve(jsonResponse(me));
    if (url === '/v1/auth/logout') return Promise.resolve(jsonResponse({ ok: true }));
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  const rootRoute = createRootRoute({ component: SecurityPage });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/security'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <ToastProvider dismissLabel="Close">
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );

  return fetchMock;
}

describe('SecurityPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('renders_email_not_verified_and_mfa_not_set_up', async () => {
    setAccessToken('test-token');
    renderPage(meBody());

    await screen.findByText('a@example.com');
    expect(screen.getByText('a@example.com')).not.toBeNull();
    expect(screen.getByText('Not verified')).not.toBeNull();
    expect(screen.getByText('Not set up')).not.toBeNull();
    expect(screen.getByTestId('security-mfa-setup-button')).not.toBeNull();
    // P28 Unit U7 replaced the honest "not available yet" placeholder with
    // the real change-password form (covered by security-password.test.tsx).
    expect(screen.getByTestId('security-password-submit')).not.toBeNull();
  });

  it('renders_email_verified_and_mfa_enabled_since_date', async () => {
    setAccessToken('test-token');
    renderPage(
      meBody({
        emailVerifiedAt: '2026-01-01T00:00:00.000Z',
        mfaEnabledAt: '2026-02-02T00:00:00.000Z',
      }),
    );

    await screen.findByText('Verified');
    expect(screen.getByText('Verified')).not.toBeNull();
    expect(screen.queryByTestId('security-mfa-setup-button')).toBeNull();
    expect(screen.getByText(/Recovery codes were shown once at setup/)).not.toBeNull();
  });

  it('sign_out_button_runs_the_logout_flow', async () => {
    setAccessToken('test-token');
    // Uses the shared `renderPage` helper (which mounts `ToastProvider`, as
    // the real `_authed` layout does) rather than duplicating the render.
    const fetchMock = renderPage(meBody());

    fireEvent.click(await screen.findByTestId('security-signout-button'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0] === '/v1/auth/logout')).toBe(true);
    });
  });
});
