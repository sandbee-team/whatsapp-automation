'use client';

import * as React from 'react';
import { Button, useT } from '@wp/ui';
import { CONTACTS_COPY } from '@wp/domain';
import type { ContactImportItem } from './api.js';

/**
 * ImportResult (P20 Unit U9, step 10) - the wizard's final step: five
 * counters (imported/updated/duplicates/invalid/opted-out preserved),
 * `CONTACTS_COPY.invalidRowsNote` when `invalidCount > 0`,
 * `CONTACTS_COPY.optedOutPreservedNote` when `optedOutCount > 0`,
 * `lastErrorReason` when `status === 'failed'` (rendered through
 * `contacts.import.error.<reason>` with a generic fallback), and a
 * "Download error CSV" button only when `invalidCount > 0`.
 */
export interface ImportResultProps {
  item: Pick<
    ContactImportItem,
    | 'status'
    | 'importedCount'
    | 'updatedCount'
    | 'duplicateCount'
    | 'invalidCount'
    | 'optedOutCount'
    | 'lastErrorReason'
  >;
  onDownloadErrors: () => void;
  downloadingErrors?: boolean;
  onClose: () => void;
}

export function ImportResult({
  item,
  onDownloadErrors,
  downloadingErrors = false,
  onClose,
}: ImportResultProps): React.JSX.Element {
  const t = useT();

  const errorKey = item.lastErrorReason
    ? (`contacts.import.error.${item.lastErrorReason}` as const)
    : null;

  return (
    <div data-testid="import-result" className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold font-ui text-fg">{t('contacts.import.result.title')}</h2>

      <dl className="grid grid-cols-2 gap-3 text-sm font-ui text-fg">
        <div>
          <dt className="text-muted">{t('contacts.import.result.imported')}</dt>
          <dd data-testid="import-result-imported">{item.importedCount}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('contacts.import.result.updated')}</dt>
          <dd data-testid="import-result-updated">{item.updatedCount}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('contacts.import.result.duplicates')}</dt>
          <dd data-testid="import-result-duplicates">{item.duplicateCount}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('contacts.import.result.invalid')}</dt>
          <dd data-testid="import-result-invalid">{item.invalidCount}</dd>
        </div>
        <div>
          <dt className="text-muted">{t('contacts.import.result.optedOutPreserved')}</dt>
          <dd data-testid="import-result-opted-out">{item.optedOutCount}</dd>
        </div>
      </dl>

      {item.invalidCount > 0 ? (
        <p data-testid="import-result-invalid-note" className="text-sm font-ui text-muted">
          {CONTACTS_COPY.invalidRowsNote}
        </p>
      ) : null}

      {item.optedOutCount > 0 ? (
        <p data-testid="import-result-optedout-note" className="text-sm font-ui text-muted">
          {CONTACTS_COPY.optedOutPreservedNote}
        </p>
      ) : null}

      {item.status === 'failed' ? (
        <p role="alert" data-testid="import-result-error" className="text-sm font-ui text-danger">
          {errorKey && isKnownErrorKey(errorKey) ? t(errorKey) : t('contacts.import.error.generic')}
        </p>
      ) : null}

      {item.invalidCount > 0 ? (
        <Button
          type="button"
          variant="secondary"
          data-testid="import-result-download-errors"
          loading={downloadingErrors}
          loadingLabel={t('common.loading')}
          onClick={onDownloadErrors}
        >
          {t('contacts.import.downloadErrorsButton')}
        </Button>
      ) : null}

      <Button type="button" data-testid="import-result-close" onClick={onClose}>
        {t('contacts.import.closeButton')}
      </Button>
    </div>
  );
}

const KNOWN_ERROR_KEYS = new Set(['contacts.import.error.max_contacts_exceeded']);

function isKnownErrorKey(key: string): key is 'contacts.import.error.max_contacts_exceeded' {
  return KNOWN_ERROR_KEYS.has(key);
}
