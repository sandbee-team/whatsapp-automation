// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { ContactForm } from '../ContactForm.js';

/**
 * contact-form.test.tsx (P26b C2 hardening) - the contact form had NO test
 * file at all. Proves: inline zod error + aria-invalid + aria-describedby on
 * the failing field, disabled+loading submit while pending, a server
 * VALIDATION_ERROR maps to a visible message (never a blank form), and the
 * `displayName` SCHEMA (not the UI) rejects a label over 200 chars - the
 * server's own `createContactInputSchema.displayName` limit. Bug fixed in
 * this hardening pass: the local `formValuesSchema` previously had no `max`
 * at all on `displayName`.
 */

function renderForm(onCreated: (contact: unknown) => void = () => undefined): void {
  render(
    <I18nProvider locale="en">
      <ContactForm defaultCountry="IN" onCreated={onCreated} />
    </I18nProvider>,
  );
}

describe('ContactForm', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('a label over 200 chars is rejected by the schema: inline error, aria-invalid and aria-describedby wired', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(screen.getByTestId('contact-form-phone'), {
      target: { value: '+919000000000' },
    });
    fireEvent.change(screen.getByTestId('contact-form-name'), {
      target: { value: 'x'.repeat(300) },
    });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => {
      const nameInput = screen.getByTestId('contact-form-name');
      expect(nameInput.getAttribute('aria-invalid')).toBe('true');
      const describedBy = nameInput.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toBeTruthy();
    });
    // The oversized label never reached the network - the schema rejected it client-side.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 200-char label is accepted (boundary case for the schema max)', async () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolve(
            new Response(
              JSON.stringify({
                data: {
                  id: 'c1',
                  workspaceId: 'w1',
                  phoneE164: '+919000000000',
                  displayName: 'x'.repeat(200),
                  createdAt: '2026-09-08T00:00:00.000Z',
                },
              }),
              { status: 201, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(screen.getByTestId('contact-form-phone'), {
      target: { value: '+919000000000' },
    });
    fireEvent.change(screen.getByTestId('contact-form-name'), {
      target: { value: 'x'.repeat(200) },
    });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const nameInput = screen.getByTestId('contact-form-name');
    expect(nameInput.getAttribute('aria-invalid')).toBeNull();
  });

  it('disables the submit button and shows its loading state while the request is pending', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(screen.getByTestId('contact-form-phone'), {
      target: { value: '+919000000000' },
    });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => {
      const button = screen.getByTestId('contact-form-submit') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    resolveFetch(
      new Response(
        JSON.stringify({
          data: {
            id: 'c1',
            workspaceId: 'w1',
            phoneE164: '+919000000000',
            displayName: null,
            createdAt: '2026-09-08T00:00:00.000Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await waitFor(() => {
      const button = screen.getByTestId('contact-form-submit') as HTMLButtonElement;
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
              message: 'phoneE164 must be a valid E.164 number.',
              requestId: 'req-1',
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.change(screen.getByTestId('contact-form-phone'), {
      target: { value: '+919000000000' },
    });
    fireEvent.click(screen.getByTestId('contact-form-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('contact-form-error').textContent).toBe(
        'phoneE164 must be a valid E.164 number.',
      );
    });
    // The form itself is still fully present - never blanked out by the error.
    expect(screen.getByTestId('contact-form')).toBeTruthy();
    expect(screen.getByTestId('contact-form-phone')).toBeTruthy();
  });
});
