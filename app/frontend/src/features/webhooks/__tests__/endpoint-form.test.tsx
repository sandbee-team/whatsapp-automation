// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, type Locale } from '@wp/ui';
import { BANNED_CLAIMS } from '@wp/domain';
import { EndpointForm } from '../components/endpoint-form.js';

/**
 * endpoint-form.test.tsx (P15 U6, step 9) - the honest webhook-form copy
 * proof: renders in both `en`/`hi` and states at-least-once delivery +
 * `X-WP-Event-Id` dedupe, never a banned claim ("instant"/"guaranteed"/
 * "exactly once"). Same locale-parametrized idiom as
 * `features/dashboard/__tests__/empty-dashboard.test.tsx`.
 */
function renderForm(locale: Locale): void {
  render(
    <I18nProvider locale={locale}>
      <EndpointForm onCreated={() => undefined} />
    </I18nProvider>,
  );
}

describe('EndpointForm', () => {
  afterEach(() => {
    cleanup();
  });

  it.each<Locale>(['en', 'hi'])(
    'the_form_states_at_least_once_delivery_and_promises_nothing (%s)',
    (locale) => {
      renderForm(locale);

      const form = screen.getByTestId('webhook-endpoint-form');
      const text = form.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);

      // Honest, factual delivery-semantics copy must be present.
      const deliveryNotice = screen.getByTestId('webhook-delivery-notice').textContent ?? '';
      expect(deliveryNotice).toMatch(/X-WP-Event-Id/);
      expect(deliveryNotice.toLowerCase()).toMatch(/at-least-once|कम-से-कम एक बार/);

      const sseHint = screen.getByTestId('webhook-sse-hint').textContent ?? '';
      expect(sseHint.toLowerCase()).toMatch(/state hint|स्टेट हिंट/);

      const lowerText = text.toLowerCase();
      const bannedLowercase = [
        'instant',
        'guaranteed',
        'exactly once',
        'तुरंत',
        'गारंटी',
        'एक ही बार',
      ];
      for (const claim of bannedLowercase) {
        expect(lowerText).not.toContain(claim.toLowerCase());
      }
      for (const claim of BANNED_CLAIMS) {
        expect(lowerText).not.toContain(claim.toLowerCase());
      }
    },
  );

  it('a URL over the schema max (2048 chars) is rejected by the schema, never submitted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderForm('en');

    const hugeUrl = `https://example.com/${'a'.repeat(2048)}`;
    fireEvent.change(screen.getByTestId('webhook-url-input'), { target: { value: hugeUrl } });
    fireEvent.click(screen.getByTestId('webhook-event-message.job.status_changed'));
    fireEvent.click(screen.getByTestId('webhook-form-submit'));

    await waitFor(() => {
      const urlInput = screen.getByTestId('webhook-url-input');
      expect(urlInput.getAttribute('aria-invalid')).toBe('true');
      const describedBy = urlInput.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      // `aria-describedby` is a space-separated token list (description +
      // error ids here) - each token must resolve to a real element with
      // real text, never a single getElementById call on the whole string.
      const describedIds = describedBy!.split(' ').filter(Boolean);
      expect(describedIds.length).toBeGreaterThan(0);
      for (const id of describedIds) {
        expect(document.getElementById(id)?.textContent).toBeTruthy();
      }
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
    vi.stubGlobal('fetch', fetchMock);
    renderForm('en');

    fireEvent.change(screen.getByTestId('webhook-url-input'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByTestId('webhook-event-message.job.status_changed'));
    fireEvent.click(screen.getByTestId('webhook-form-submit'));

    await waitFor(() => {
      const button = screen.getByTestId('webhook-form-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveFetch(
      new Response(
        JSON.stringify({
          data: {
            id: 'e1',
            url: 'https://example.com/hook',
            events: ['message.job.status_changed'],
            enabled: true,
            secret: 'whsec_test',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await waitFor(() => {
      const button = screen.getByTestId('webhook-form-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it('a server VALIDATION_ERROR maps to a visible message, never a blank form', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'url must use https.',
              requestId: 'req-1',
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm('en');

    fireEvent.change(screen.getByTestId('webhook-url-input'), {
      target: { value: 'https://example.com/hook' },
    });
    fireEvent.click(screen.getByTestId('webhook-event-message.job.status_changed'));
    fireEvent.click(screen.getByTestId('webhook-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('webhook-form-error').textContent).toBe('url must use https.');
    });
    expect(screen.getByTestId('webhook-endpoint-form')).toBeTruthy();
    expect(screen.getByTestId('webhook-url-input')).toBeTruthy();
  });
});
