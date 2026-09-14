// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { LoginForm } from '../../features/auth/components/login-form.js';

/**
 * login.test.tsx (P28 Unit U6, step 9) - staff login requires all three
 * factors (submit stays disabled until email + password + 6-digit TOTP are
 * all present), and lockout/allow-list errors render their honest copy.
 */
function jsonErrorResponse(code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: 'nope', requestId: 'req-1' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderLogin(): void {
  const rootRoute = createRootRoute({ component: LoginForm });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  });
  render(
    <I18nProvider locale="en">
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

async function fillForm(email: string, password: string, totp: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('admin-login-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('admin-login-password'), { target: { value: password } });
  if (totp.length > 0) {
    const otpLabel = screen.getByText('Authenticator code');
    const group = otpLabel.parentElement?.querySelector('[role="group"]');
    const cells = group?.querySelectorAll('input') ?? [];
    for (let index = 0; index < totp.length && index < cells.length; index += 1) {
      fireEvent.change(cells[index]!, { target: { value: totp[index] } });
    }
  }
}

describe('staff_login_requires_all_three_factors', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('the submit button stays disabled until email, password and a 6-digit TOTP are all present', async () => {
    renderLogin();
    const submit = await screen.findByTestId('admin-login-submit');
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    await fillForm('staff@example.com', 'correct horse battery staple', '');
    expect((screen.getByTestId('admin-login-submit') as HTMLButtonElement).disabled).toBe(true);

    await fillForm('staff@example.com', 'correct horse battery staple', '123456');
    await waitFor(() => {
      expect((screen.getByTestId('admin-login-submit') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('never calls fetch while the form is incomplete', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    fireEvent.click(await screen.findByTestId('admin-login-submit'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('lockout_and_ip_errors_render_honest_copy', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'ACCOUNT_LOCKED',
      'This account is temporarily locked after repeated failed attempts. Please try again later.',
    ],
    ['MFA_ENROLL_REQUIRED', 'This staff account has no authenticator enrolled - ask a superadmin.'],
    ['FORBIDDEN', 'This network is not allow-listed.'],
    ['SOMETHING_ELSE', 'Something went wrong. Please try again.'],
  ])('maps_%s_to_its_honest_copy', async (code, expectedMessage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonErrorResponse(code))),
    );
    renderLogin();

    await fillForm('staff@example.com', 'correct horse battery staple', '123456');
    fireEvent.click(await screen.findByTestId('admin-login-submit'));

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).toBeTruthy();
    });
  });
});
