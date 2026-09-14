// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@wp/ui';
import { TopupRequestForm } from '../components/topup-request-form.js';

/**
 * topup-request-form-validation.test.tsx (P26b C2 hardening) - inline zod
 * error + aria-invalid/aria-describedby on the failing field, disabled+
 * loading submit while pending, and a server VALIDATION_ERROR mapping to a
 * visible message (never a blank form). Companion to
 * `topup-request-form-idempotency.test.tsx` (which covers key reuse only).
 */

function renderForm(fetchMock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nProvider locale="en">
      <QueryClientProvider client={queryClient}>
        <TopupRequestForm onSubmitted={() => undefined} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe('TopupRequestForm validation', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('an empty amount is rejected inline: aria-invalid + aria-describedby wired, request never sent', async () => {
    const fetchMock = vi.fn();
    renderForm(fetchMock);

    fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR12345' } });
    fireEvent.click(screen.getByTestId('topup-form-submit'));

    await waitFor(() => {
      const amountInput = screen.getByTestId('topup-amount-input');
      expect(amountInput.getAttribute('aria-invalid')).toBe('true');
      const describedBy = amountInput.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const ids = describedBy!.split(' ').filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(document.getElementById(id)?.textContent).toBeTruthy();
      }
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a UTR over the schema max (255 chars) is rejected inline, never submitted', async () => {
    const fetchMock = vi.fn();
    renderForm(fetchMock);

    fireEvent.change(screen.getByTestId('topup-amount-input'), { target: { value: '100.00' } });
    fireEvent.change(screen.getByTestId('topup-utr-input'), {
      target: { value: 'x'.repeat(256) },
    });
    fireEvent.click(screen.getByTestId('topup-form-submit'));

    await waitFor(() => {
      const utrInput = screen.getByTestId('topup-utr-input');
      expect(utrInput.getAttribute('aria-invalid')).toBe('true');
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is pending', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    renderForm(fetchMock);

    fireEvent.change(screen.getByTestId('topup-amount-input'), { target: { value: '100.00' } });
    fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR12345' } });
    fireEvent.click(screen.getByTestId('topup-form-submit'));

    await waitFor(() => {
      const button = screen.getByTestId('topup-form-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveFetch(
      new Response(
        JSON.stringify({
          data: {
            id: 't1',
            amountMinor: '10000',
            status: 'pending',
            createdAt: '2026-09-08T00:00:00.000Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await waitFor(() => {
      const button = screen.getByTestId('topup-form-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it("the method Select's label is associated with its trigger (MINOR-12)", async () => {
    const fetchMock = vi.fn();
    renderForm(fetchMock);

    // The FormField wrapper previously discarded its render-prop args and
    // duplicated a dangling, unassociated label - `Select` renders its OWN
    // label internally via `aria-labelledby`, so the accessible name must
    // resolve to exactly the method label with no duplicate/orphaned label
    // in the document.
    const trigger = await screen.findByRole('combobox', { name: 'Payment method' });
    expect(trigger).toBeTruthy();

    const labels = screen.getAllByText('Payment method');
    expect(labels).toHaveLength(1);
  });

  it('a server VALIDATION_ERROR maps to a visible message, never a blank form', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'amountMinor must be positive.',
              requestId: 'req-1',
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    renderForm(fetchMock);

    fireEvent.change(screen.getByTestId('topup-amount-input'), { target: { value: '100.00' } });
    fireEvent.change(screen.getByTestId('topup-utr-input'), { target: { value: 'UTR12345' } });
    fireEvent.click(screen.getByTestId('topup-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('topup-form-error').textContent).toBe(
        'amountMinor must be positive.',
      );
    });
    expect(screen.getByTestId('topup-request-form')).toBeTruthy();
    expect(screen.getByTestId('topup-amount-input')).toBeTruthy();
  });
});
