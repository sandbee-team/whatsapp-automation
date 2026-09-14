// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@wp/ui';
import { CONTACTS_COPY } from '@wp/domain';
import { ContactsExportAction } from '../ContactsExportAction.js';

/**
 * contacts-export-action.test.tsx (P26b U5) - the restyled export action's
 * `AlertDialog` confirm step (shows `CONTACTS_COPY.exportNote` before any
 * network call) and the honest `MFA_REQUIRED` error mapping.
 */
function renderAction(): void {
  render(
    <I18nProvider locale="en">
      <ContactsExportAction />
    </I18nProvider>,
  );
}

describe('ContactsExportAction', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the export note before any network call, and no fetch fires until confirmed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderAction();
    fireEvent.click(screen.getByTestId('contacts-export-button'));

    await screen.findByText(CONTACTS_COPY.exportNote);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 401 MFA_REQUIRED failure to the honest re-authenticate message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'MFA_REQUIRED', message: 'mfa required', requestId: 'r1' },
            }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    renderAction();
    fireEvent.click(screen.getByTestId('contacts-export-button'));

    const confirmButton = await screen.findByRole('button', { name: 'Download CSV' });
    fireEvent.click(confirmButton);

    const error = await waitFor(() => screen.getByTestId('contacts-export-error'));
    expect(error.textContent).toBe('Re-authenticate with your authenticator code to continue.');
  });
});
