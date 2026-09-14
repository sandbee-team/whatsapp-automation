'use client';

import * as React from 'react';
import { AlertDialog, Button, useT } from '@wp/ui';
import { CONTACTS_COPY } from '@wp/domain';
import { ApiError } from '../../lib/api-client.js';
import { downloadContactsExportCsv } from './api.js';

/**
 * ContactsExportAction (P20 Unit U9, step 10; P26b U5 restyle) - the
 * "Export CSV" header action: an `AlertDialog` confirm showing
 * `CONTACTS_COPY.exportNote` BEFORE any network call
 * (`contacts-export-confirm*` ids kept on the dialog's own surface via
 * `data-testid` on the wrapping span, since `AlertDialog` itself renders no
 * body slot beyond its `body` string prop), then `apiFetchRaw` -> blob -> a
 * programmatic anchor click, revoking the object URL immediately after. A
 * 401 `MFA_REQUIRED` surfaces as `contacts.mfaRequired` - re-authenticate
 * honestly, never silently retried; the error renders inline (never a
 * silently swallowed failure) since the dialog closes on any non-error
 * confirm path.
 */
export function ContactsExportAction(): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onConfirm = async (): Promise<void> => {
    setDownloading(true);
    setError(null);
    try {
      const blob = await downloadContactsExportCsv();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'contacts-export.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'MFA_REQUIRED') {
        setError(t('contacts.mfaRequired'));
      } else {
        setError(caught instanceof ApiError ? caught.message : t('contacts.error'));
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div data-testid="contacts-export-confirm" className="contents">
      <Button
        type="button"
        variant="secondary"
        data-testid="contacts-export-button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {t('contacts.exportButton')}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={setOpen}
        title={t('contacts.export.confirmTitle')}
        body={CONTACTS_COPY.exportNote}
        confirmLabel={t('contacts.export.confirmButton')}
        cancelLabel={t('contacts.export.cancelButton')}
        loading={downloading}
        onConfirm={() => void onConfirm()}
      />

      {error ? (
        <p
          role="alert"
          data-testid="contacts-export-error"
          className="mt-2 text-sm font-ui text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
