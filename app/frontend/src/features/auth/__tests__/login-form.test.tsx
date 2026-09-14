// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { LoginForm } from '../components/login-form.js';

/**
 * login-form.test.tsx (P26b U2) - maps ACCOUNT_LOCKED / EMAIL_NOT_VERIFIED /
 * UNAUTHENTICATED error codes to their `ONBOARDING_COPY.login` messages.
 */
function jsonErrorResponse(code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: 'nope', requestId: 'req-1' } }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderLogin(): void {
  const queryClient = new QueryClient();
  const rootRoute = createRootRoute({ component: LoginForm });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  });

  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

async function submit(email: string, password: string): Promise<void> {
  fireEvent.change(await screen.findByTestId('login-email'), { target: { value: email } });
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } });
  fireEvent.click(screen.getByTestId('login-submit'));
}

describe('LoginForm', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['ACCOUNT_LOCKED', 'This account is temporarily locked. Please try again later.'],
    ['EMAIL_NOT_VERIFIED', 'Please verify your email before signing in.'],
    ['UNAUTHENTICATED', 'Incorrect email or password.'],
    ['SOMETHING_ELSE', 'Something went wrong. Please try again.'],
  ])('maps_%s_to_its_copy', async (code, expectedMessage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonErrorResponse(code))),
    );
    renderLogin();

    await submit('owner@example.com', 'correct horse battery staple');

    await waitFor(() => {
      expect(screen.getByText(expectedMessage)).not.toBeUndefined();
    });
  });

  it("a server VALIDATION_ERROR maps to the server's own visible message, never the generic fallback", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'email must be a valid address.',
                requestId: 'req-1',
              },
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      ),
    );
    renderLogin();

    await submit('owner@example.com', 'correct horse battery staple');

    await waitFor(() => {
      expect(screen.getByText('email must be a valid address.')).toBeTruthy();
    });
    // Never a blank form - the fields stay present with their typed values.
    expect((screen.getByTestId('login-email') as HTMLInputElement).value).toBe('owner@example.com');
  });

  it('an invalid submit shows an inline zod error with aria-invalid and aria-describedby wired', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    fireEvent.change(await screen.findByTestId('login-email'), {
      target: { value: 'not-an-email' },
    });
    fireEvent.click(screen.getByTestId('login-submit'));

    await waitFor(() => {
      const emailInput = screen.getByTestId('login-email');
      expect(emailInput.getAttribute('aria-invalid')).toBe('true');
      const describedBy = emailInput.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const ids = describedBy!.split(' ').filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(document.getElementById(id)?.textContent).toBeTruthy();
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forgot_password_links_to_the_forgot_password_route', async () => {
    // P28 Unit U7 replaced the previous "not available yet" Dialog with a
    // real link to `/forgot-password` - the flow now exists, so the honest
    // placeholder copy is gone (and its i18n key with it).
    renderLogin();

    const link = await screen.findByTestId('login-forgot-password');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/forgot-password');
    expect(link.textContent).toBe('Forgot your password?');
  });

  it('disables the submit button while the request is pending', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderLogin();

    await submit('owner@example.com', 'correct horse battery staple');

    await waitFor(() => {
      const button = screen.getByTestId('login-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveFetch(
      new Response(JSON.stringify({ data: { kind: 'ok' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
