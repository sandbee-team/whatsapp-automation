// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ConnectSheet } from '../ConnectSheet.js';
import { INSTANCE_ID, jsonResponse } from './connect-sheet-test-helpers.js';

/**
 * connect-sheet-mfa.test.tsx (P26b, security follow-up) - the two-factor
 * error stages: `MFA_ENROLL_REQUIRED` (no TOTP enrolled yet) renders a
 * "set up two-factor" call to action, `MFA_REQUIRED` (enrolled but this
 * session never verified) renders a "sign in again" call to action that
 * runs the same logout logic as the user menu. Mocks the global `fetch`
 * only, never the feature's own `api.ts` module - same idiom as
 * `connect-sheet.test.tsx`.
 */

function renderConnectSheetWithRouter(): { navigate: () => string[] } {
  const visited: string[] = [];
  const rootRoute = createRootRoute({
    component: () => <ConnectSheet open onOpenChange={() => undefined} />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  router.subscribe('onResolved', () => {
    visited.push(router.state.location.pathname);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { navigate: () => visited };
}

async function createInstanceAndSubmitLabel(label = 'Sales'): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('connect-label-input')).not.toBeNull();
  });
  fireEvent.change(screen.getByTestId('connect-label-input'), { target: { value: label } });
  fireEvent.click(screen.getByTestId('connect-create-button'));
}

describe('ConnectSheet - MFA stages', () => {
  beforeEach(() => {
    setAccessToken('test-token');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('mfa_enroll_required_renders_setup_alert_and_button', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/v1/instances' && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'MFA_ENROLL_REQUIRED',
                message: 'TOTP MFA enrolment is required for this account.',
                requestId: 'r1',
              },
            },
            403,
          ),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheetWithRouter();
    await createInstanceAndSubmitLabel();

    const alert = await screen.findByTestId('connect-mfa-required');
    expect(alert.textContent).toContain(
      'Two-factor authentication is required before you can connect a number',
    );
    expect(screen.getByTestId('connect-mfa-setup-button')).not.toBeNull();
    expect(screen.queryByTestId('connect-mfa-signin-button')).toBeNull();
  });

  it('mfa_required_renders_signin_alert_and_signs_out_on_click', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/v1/instances' && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'MFA_REQUIRED',
                message: 'This session has not been verified with two-factor.',
                requestId: 'r1',
              },
            },
            403,
          ),
        );
      }
      if (url === '/v1/auth/logout' && method === 'POST') {
        return Promise.resolve(jsonResponse({ data: { ok: true } }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheetWithRouter();
    await createInstanceAndSubmitLabel();

    const alert = await screen.findByTestId('connect-mfa-required');
    expect(alert.textContent).toContain('Sign in again to continue');
    expect(screen.queryByTestId('connect-mfa-setup-button')).toBeNull();

    const signInButton = screen.getByTestId('connect-mfa-signin-button');
    fireEvent.click(signInButton);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => call[0] === '/v1/auth/logout')).toBe(true);
    });
  });

  it('other_error_codes_keep_the_existing_generic_behaviour', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url === '/v1/instances' && method === 'POST') {
        return Promise.resolve(
          jsonResponse({
            data: {
              id: INSTANCE_ID,
              label: 'Sales',
              linkState: 'unlinked',
              healthState: 'never_linked',
              desiredState: 'offline',
            },
            meta: { requestId: 'r1' },
          }),
        );
      }
      if (url === `/v1/instances/${INSTANCE_ID}/link-status`) {
        return Promise.resolve(
          jsonResponse({
            data: {
              linkState: 'unlinked',
              healthState: 'never_linked',
              desiredState: 'offline',
              needsUserAction: false,
              userActionReason: null,
              attemptsLeft: 3,
              maskedNumber: null,
            },
            meta: { requestId: 'r2' },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderConnectSheetWithRouter();
    await createInstanceAndSubmitLabel();

    await waitFor(() => {
      expect(screen.getByTestId('connect-method-qr')).not.toBeNull();
    });
    expect(screen.queryByTestId('connect-mfa-required')).toBeNull();
  });
});
