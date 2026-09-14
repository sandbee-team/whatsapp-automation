// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { setAccessToken } from '../../lib/api-client.js';
import { ForgotPasswordForm, ResetPasswordForm } from '../../features/auth/index.js';

/**
 * forgot-reset-password.test.tsx (P28 Unit U7) - the public password-recovery
 * pair. The forgot page NEVER varies its confirmation (no existence oracle:
 * an unknown email, a known email, and even a transport failure all show the
 * same text), and the reset page treats a 400 as "this single-use link is
 * spent" with a request-a-new-link action rather than a retry.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message: 'invalid token', requestId: 'r1' },
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  );
}

const SAME_CONFIRMATION =
  "If an account exists for that email, we've sent a link. It expires in 30 minutes.";

function renderWithRouter(component: () => React.JSX.Element, initialPath: string) {
  const rootRoute = createRootRoute();
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="login-screen">login</div>,
  });
  const forgotRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/forgot-password',
    component: () => <div data-testid="forgot-password-screen">forgot</div>,
  });
  const target = createRoute({
    getParentRoute: () => rootRoute,
    path: initialPath,
    component,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([loginRoute, forgotRoute, target]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );

  return router;
}

describe('forgot / reset password', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('forgot_password_always_shows_the_same_confirmation', async () => {
    const responses: Response[] = [
      jsonResponse({ accepted: true }),
      jsonResponse({ accepted: true }),
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/v1/auth/password/forgot') {
        return Promise.resolve(responses.shift() ?? jsonResponse({ accepted: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // A known-looking address.
    renderWithRouter(() => <ForgotPasswordForm />, '/forgot-password-page');
    fireEvent.change(await screen.findByTestId('forgot-password-email'), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.click(screen.getByTestId('forgot-password-submit'));
    const first = await screen.findByTestId('forgot-password-confirmation');
    expect(first.textContent).toContain(SAME_CONFIRMATION);
    cleanup();

    // An address that does not exist - byte-identical confirmation.
    renderWithRouter(() => <ForgotPasswordForm />, '/forgot-password-page');
    fireEvent.change(await screen.findByTestId('forgot-password-email'), {
      target: { value: 'nobody@example.com' },
    });
    fireEvent.click(screen.getByTestId('forgot-password-submit'));
    const second = await screen.findByTestId('forgot-password-confirmation');
    expect(second.textContent).toContain(SAME_CONFIRMATION);
  });

  it('reset_password_posts_token_and_new_password_then_navigates_to_login', async () => {
    let sentBody: BodyInit | null | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/v1/auth/password/reset') {
        sentBody = init?.body;
        return Promise.resolve(jsonResponse({ reset: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = 'a'.repeat(40);
    const router = renderWithRouter(
      () => (
        <ToastProvider dismissLabel="Close">
          <ResetPasswordForm token={token} />
        </ToastProvider>
      ),
      '/reset-password-page',
    );

    fireEvent.change(await screen.findByTestId('reset-password-new'), {
      target: { value: 'brand-new-password-1' },
    });
    fireEvent.change(screen.getByTestId('reset-password-confirm'), {
      target: { value: 'brand-new-password-1' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('reset-password-submit')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(JSON.parse(String(sentBody))).toEqual({
      token,
      newPassword: 'brand-new-password-1',
    });

    await vi.waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });

  it('reset_password_with_an_invalid_token_shows_request_new_link', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/v1/auth/password/reset') return Promise.resolve(badRequest());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWithRouter(
      () => (
        <ToastProvider dismissLabel="Close">
          <ResetPasswordForm token={'b'.repeat(40)} />
        </ToastProvider>
      ),
      '/reset-password-page',
    );

    fireEvent.change(await screen.findByTestId('reset-password-new'), {
      target: { value: 'brand-new-password-1' },
    });
    fireEvent.change(screen.getByTestId('reset-password-confirm'), {
      target: { value: 'brand-new-password-1' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('reset-password-submit')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('reset-password-submit'));

    const errorState = await screen.findByTestId('reset-password-invalid-token');
    expect(errorState.textContent).toContain('This link is not valid');
    const requestNew = screen.getByTestId('reset-password-request-new-link');
    expect(requestNew.getAttribute('href')).toBe('/forgot-password');
  });
});
