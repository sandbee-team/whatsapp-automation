// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { I18nProvider, ToastProvider } from '@wp/ui';
import { setAccessToken } from '../../../lib/api-client.js';
import { ChangePasswordCard } from '../components/change-password-card.js';

/**
 * security-password.test.tsx (P28 Unit U7) - the `/settings/security`
 * Password card: the submit stays disabled until the form is valid AND the
 * confirm matches, a success posts exactly the `changePasswordInputSchema`
 * body (never the confirm field) and resets the form, and a 401 surfaces
 * INLINE on the current-password field rather than as a generic toast.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ data: body, meta: { requestId: 'r1' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'UNAUTHENTICATED', message: 'wrong password', requestId: 'r1' },
    }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
}

function renderCard(): void {
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider dismissLabel="Close">
        <ChangePasswordCard />
      </ToastProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/security'] }),
  });
  render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

async function fill(current: string, next: string, confirm: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('security-password-current'), {
    target: { value: current },
  });
  fireEvent.change(screen.getByTestId('security-password-new'), { target: { value: next } });
  fireEvent.change(screen.getByTestId('security-password-confirm'), {
    target: { value: confirm },
  });
}

describe('ChangePasswordCard', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('change_password_stays_disabled_until_valid_and_matching', async () => {
    setAccessToken('test-token');
    const fetchMock = vi.fn(() => {
      throw new Error('no request may be issued while the form is invalid');
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    const submit = await screen.findByTestId('security-password-submit');
    expect(submit).toHaveProperty('disabled', true);

    // Valid new password, but the confirm does not match -> still disabled.
    await fill('current-password-1', 'brand-new-password-1', 'brand-new-password-2');
    await waitFor(() => {
      expect(submit).toHaveProperty('disabled', true);
    });

    // A new password shorter than the 12-character contract minimum.
    await fill('current-password-1', 'short', 'short');
    await waitFor(() => {
      expect(submit).toHaveProperty('disabled', true);
    });

    await fill('current-password-1', 'brand-new-password-1', 'brand-new-password-1');
    await waitFor(() => {
      expect(submit).toHaveProperty('disabled', false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('change_password_posts_the_contract_body_and_resets_on_success', async () => {
    setAccessToken('test-token');
    let sentBody: BodyInit | null | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/v1/auth/password/change') {
        sentBody = init?.body;
        return Promise.resolve(jsonResponse({ changed: true, otherSessionsRevoked: 2 }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    await fill('current-password-1', 'brand-new-password-1', 'brand-new-password-1');
    await waitFor(() => {
      expect(screen.getByTestId('security-password-submit')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('security-password-submit'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    expect(JSON.parse(String(sentBody))).toEqual({
      currentPassword: 'current-password-1',
      newPassword: 'brand-new-password-1',
    });

    await screen.findByText('Your password has been changed.');
    expect(
      screen.getByText('Your other sessions were signed out for your security.'),
    ).not.toBeNull();

    await waitFor(() => {
      expect(screen.getByTestId('security-password-current')).toHaveProperty('value', '');
      expect(screen.getByTestId('security-password-new')).toHaveProperty('value', '');
    });
  });

  it('a_wrong_current_password_shows_an_inline_error', async () => {
    setAccessToken('test-token');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/v1/auth/password/change') return Promise.resolve(unauthorized());
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCard();

    await fill('wrong-current-pass', 'brand-new-password-1', 'brand-new-password-1');
    await waitFor(() => {
      expect(screen.getByTestId('security-password-submit')).toHaveProperty('disabled', false);
    });
    fireEvent.click(screen.getByTestId('security-password-submit'));

    await screen.findByText('That current password is incorrect.');
    // Inline on the field, never a toast.
    expect(screen.queryByText('Something went wrong. Please try again.')).toBeNull();
    const field = screen.getByTestId('security-password-current');
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });
});
