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
import { SignupForm } from '../components/signup-form.js';

/**
 * signup-form.test.tsx (P26b U2) - inline zod errors show for an invalid
 * submit, the submit button disables while the request is pending, and a
 * successful submit shows the success card.
 */
function renderSignup(): void {
  const queryClient = new QueryClient();
  const rootRoute = createRootRoute({ component: SignupForm });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/signup'] }),
  });

  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('SignupForm', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows_inline_zod_errors_for_an_invalid_submit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderSignup();

    const submitButton = await screen.findByTestId('signup-submit');
    fireEvent.click(submitButton);

    await waitFor(() => {
      const fullNameInput = screen.getByTestId('signup-full-name');
      expect(fullNameInput.getAttribute('aria-invalid')).toBe('true');
      const describedBy = fullNameInput.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const ids = describedBy!.split(' ').filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(document.getElementById(id)?.textContent).toBeTruthy();
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a company name over the schema max (200 chars) is rejected inline, never submitted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderSignup();

    await screen.findByTestId('signup-full-name');
    fireEvent.change(screen.getByTestId('signup-full-name'), { target: { value: 'Ada Owner' } });
    fireEvent.change(screen.getByTestId('signup-email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByTestId('signup-phone'), { target: { value: '+919876543210' } });
    fireEvent.change(screen.getByTestId('signup-company'), {
      target: { value: 'x'.repeat(300) },
    });
    fireEvent.change(screen.getByTestId('signup-password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByTestId('signup-submit'));

    await waitFor(() => {
      const companyInput = screen.getByTestId('signup-company');
      expect(companyInput.getAttribute('aria-invalid')).toBe('true');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a server VALIDATION_ERROR maps to a visible message, never a blank form', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'phoneE164 must be a valid E.164 number.',
              requestId: 'req-1',
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSignup();

    await screen.findByTestId('signup-full-name');
    fireEvent.change(screen.getByTestId('signup-full-name'), { target: { value: 'Ada Owner' } });
    fireEvent.change(screen.getByTestId('signup-email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByTestId('signup-phone'), { target: { value: '+919876543210' } });
    fireEvent.change(screen.getByTestId('signup-company'), {
      target: { value: 'Acme Textiles' },
    });
    fireEvent.change(screen.getByTestId('signup-password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByTestId('signup-submit'));

    await waitFor(() => {
      expect(screen.getByText('phoneE164 must be a valid E.164 number.')).toBeTruthy();
    });
    // Never a blank form on error - the fields are still present with their values.
    expect(screen.getByTestId('signup-submit')).toBeTruthy();
    expect((screen.getByTestId('signup-company') as HTMLInputElement).value).toBe('Acme Textiles');
  });

  it('disables_submit_while_pending_and_shows_success_card', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderSignup();

    await screen.findByTestId('signup-full-name');
    fireEvent.change(screen.getByTestId('signup-full-name'), { target: { value: 'Ada Owner' } });
    fireEvent.change(screen.getByTestId('signup-email'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByTestId('signup-phone'), { target: { value: '+919876543210' } });
    fireEvent.change(screen.getByTestId('signup-company'), {
      target: { value: 'Acme Textiles' },
    });
    fireEvent.change(screen.getByTestId('signup-password'), {
      target: { value: 'correct horse battery staple' },
    });

    fireEvent.click(screen.getByTestId('signup-submit'));

    await waitFor(() => {
      const button = screen.getByTestId('signup-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveFetch(
      new Response(
        JSON.stringify({
          data: { userId: 'u1', clientId: 'c1', onboardingStep: 'verify_email' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await waitFor(() => {
      expect(screen.queryByTestId('signup-submit')).toBeNull();
    });
  });
});
