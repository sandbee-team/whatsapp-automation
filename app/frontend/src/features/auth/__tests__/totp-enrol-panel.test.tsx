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
import { setAccessToken } from '../../../lib/api-client.js';
import { TotpEnrolPanel } from '../components/totp-enrol-panel.js';

/**
 * totp-enrol-panel.test.tsx (P26b, security follow-up) - after confirming
 * the enrolment code and seeing the recovery codes once, the continue
 * action must sign the user out and send them to `/login` (never a plain
 * `/` navigation into the still-unverified pre-enrolment session) - so a
 * fresh login is what actually mints a verified `mfa` session (canon:
 * enrolling TOTP does not upgrade the current session).
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPanel(): void {
  const rootRoute = createRootRoute({ component: TotpEnrolPanel });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/totp'] }),
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

describe('TotpEnrolPanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('continue_after_recovery_codes_signs_out_and_goes_to_login', async () => {
    setAccessToken('test-token');
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/v1/auth/totp/enrol' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            data: { otpauthUrl: 'otpauth://totp/x', secretShownOnce: 'SECRET123' },
            meta: { requestId: 'r1' },
          }),
        );
      }
      if (url === '/v1/auth/totp/enrol/confirm' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            data: { recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] },
            meta: { requestId: 'r2' },
          }),
        );
      }
      if (url === '/v1/auth/logout' && method === 'POST') {
        return Promise.resolve(jsonResponse({ data: { ok: true }, meta: { requestId: 'r3' } }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    const codeInput = await screen.findByTestId('totp-enrol-code');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('totp-enrol-confirm'));

    await screen.findByTestId('totp-recovery-codes');

    fireEvent.click(screen.getByTestId('totp-enrol-continue'));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0] === '/v1/auth/logout')).toBe(true);
    });
  });
});
