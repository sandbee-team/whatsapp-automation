'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Progress, Stepper, useT } from '@wp/ui';
import { ApiError } from '../../lib/api-client.js';
import {
  cancelContactImport,
  createContactImport,
  downloadImportErrorsCsv,
  getContactImport,
  uploadContactImportFile,
  type ContactImportItem,
  type UploadImportResult,
} from './api.js';
import { contactsKeys } from './keys.js';
import {
  UploadStep,
  MappingStep,
  AttestationStep,
  validateUploadFile,
  type AttrMappingRow,
} from './ImportWizardSteps.js';
import { ImportResult } from './ImportResult.js';

const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

type WizardStep = 'upload' | 'mapping' | 'attestation' | 'progress' | 'result';
const WIZARD_STEP_ORDER: WizardStep[] = ['upload', 'mapping', 'attestation', 'progress', 'result'];

export interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
  /** Test-only: starts the wizard at a given step (e.g. `'attestation'`) instead of always `'upload'`. */
  initialStep?: WizardStep;
}

/**
 * ImportWizard (P20 Unit U9, step 10) - five steps: upload, mapping +
 * preview, attestation, progress (polled every 2s, stops on a terminal
 * status), result. Invalidates the contacts list query on completion so the
 * imported rows appear without a manual reload.
 */
export function ImportWizard({
  open,
  onOpenChange,
  onCompleted,
  initialStep = 'upload',
}: ImportWizardProps): React.JSX.Element {
  const t = useT();
  const [step, setStep] = React.useState<WizardStep>(initialStep);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [upload, setUpload] = React.useState<UploadImportResult | null>(null);

  const [phoneColumn, setPhoneColumn] = React.useState('');
  const [nameColumn, setNameColumn] = React.useState('');
  const [defaultCountry, setDefaultCountry] = React.useState('IN');
  const [attrRows, setAttrRows] = React.useState<AttrMappingRow[]>([]);

  const [accepted, setAccepted] = React.useState(false);
  const [sourceText, setSourceText] = React.useState('');
  const [starting, setStarting] = React.useState(false);

  const [importId, setImportId] = React.useState<string | null>(null);
  const [downloadingErrors, setDownloadingErrors] = React.useState(false);

  const reset = (): void => {
    setStep(initialStep);
    setUploadError(null);
    setUpload(null);
    setPhoneColumn('');
    setNameColumn('');
    setDefaultCountry('IN');
    setAttrRows([]);
    setAccepted(false);
    setSourceText('');
    setImportId(null);
  };

  const onFileSelected = async (file: File): Promise<void> => {
    const validationKey = validateUploadFile(file);
    if (validationKey) {
      setUploadError(t(validationKey));
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const result = await uploadContactImportFile(file);
      setUpload(result);
      setDefaultCountry(result.defaultCountry);
      setPhoneColumn(result.columns[0] ?? '');
      setStep('mapping');
    } catch (error) {
      setUploadError(error instanceof ApiError ? error.message : t('contacts.import.uploadError'));
    } finally {
      setUploading(false);
    }
  };

  const onStartImport = async (): Promise<void> => {
    if (!upload) return;
    setStarting(true);
    try {
      const attrs = Object.fromEntries(
        attrRows.filter((row) => row.key.length > 0).map((row) => [row.key, row.column]),
      );
      const item = await createContactImport({
        storageKey: upload.storageKey,
        mapping: {
          phone: phoneColumn,
          name: nameColumn || undefined,
          attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        },
        defaultCountry,
        attestationText: sourceText.trim(),
        attestationAccepted: true,
      });
      setImportId(item.id);
      setStep('progress');
    } finally {
      setStarting(false);
    }
  };

  const { data: importItem } = useQuery({
    queryKey: importId ? contactsKeys.import(importId) : ['contacts', 'imports', 'none'],
    queryFn: () => getContactImport(importId as string),
    enabled: importId !== null && step === 'progress',
    refetchInterval: (query) => {
      const current = query.state.data as ContactImportItem | undefined;
      if (current && TERMINAL_STATUSES.has(current.status)) return false;
      return POLL_INTERVAL_MS;
    },
  });

  React.useEffect(() => {
    if (importItem && TERMINAL_STATUSES.has(importItem.status)) {
      setStep('result');
      onCompleted();
    }
    // Deliberately depends only on the status transition, not `onCompleted`
    // itself - the callback identity may change across parent renders and
    // must not re-fire this effect.
  }, [importItem?.status]);

  const onCancel = async (): Promise<void> => {
    if (!importId) return;
    await cancelContactImport(importId);
  };

  const onDownloadErrors = async (): Promise<void> => {
    if (!importId) return;
    setDownloadingErrors(true);
    try {
      const blob = await downloadImportErrorsCsv(importId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'contact-import-errors.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingErrors(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={t('contacts.import.title')}
      closeLabel={t('common.close')}
      size="lg"
    >
      <div data-testid="import-wizard" className="flex flex-col gap-6">
        <Stepper
          steps={[
            { id: 'upload', label: t('contacts.import.step.upload') },
            { id: 'mapping', label: t('contacts.import.step.mapping') },
            { id: 'attestation', label: t('contacts.import.step.attestation') },
            { id: 'progress', label: t('contacts.import.step.progress') },
            { id: 'result', label: t('contacts.import.step.result') },
          ]}
          current={WIZARD_STEP_ORDER.indexOf(step)}
          orientation="horizontal"
          completedLabel={t('stepper.status.completed')}
          currentLabel={t('stepper.status.current')}
          upcomingLabel={t('stepper.status.upcoming')}
        />

        {step === 'upload' ? (
          <UploadStep
            onFileSelected={(file) => void onFileSelected(file)}
            error={uploadError}
            uploading={uploading}
          />
        ) : null}

        {step === 'mapping' && upload ? (
          <MappingStep
            upload={upload}
            phoneColumn={phoneColumn}
            onPhoneColumnChange={setPhoneColumn}
            nameColumn={nameColumn}
            onNameColumnChange={setNameColumn}
            defaultCountry={defaultCountry}
            onDefaultCountryChange={setDefaultCountry}
            attrRows={attrRows}
            onAttrRowsChange={setAttrRows}
            onContinue={() => setStep('attestation')}
          />
        ) : null}

        {step === 'attestation' ? (
          <AttestationStep
            accepted={accepted}
            onAcceptedChange={setAccepted}
            sourceText={sourceText}
            onSourceTextChange={setSourceText}
            onStart={() => void onStartImport()}
            starting={starting}
          />
        ) : null}

        {step === 'progress' ? (
          <div data-testid="import-step-progress" className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold font-ui text-fg">
              {t('contacts.import.progress.title')}
            </h2>
            <p
              aria-live="polite"
              data-testid="import-progress-counter"
              className="text-sm font-ui text-fg"
            >
              {importItem?.totalRows != null
                ? t('contacts.import.progress.rowsProcessedOfTotal', {
                    cursorRow: importItem.cursorRow,
                    totalRows: importItem.totalRows,
                  })
                : t('contacts.import.progress.rowsProcessed', {
                    cursorRow: importItem?.cursorRow ?? 0,
                  })}
            </p>
            <Progress
              value={
                importItem?.totalRows != null && importItem.totalRows > 0
                  ? Math.min(100, Math.round((importItem.cursorRow / importItem.totalRows) * 100))
                  : null
              }
              label={t('contacts.import.progress.title')}
              valueText={
                importItem?.totalRows != null
                  ? t('contacts.import.progress.rowsProcessedOfTotal', {
                      cursorRow: importItem.cursorRow,
                      totalRows: importItem.totalRows,
                    })
                  : t('contacts.import.progress.rowsProcessed', {
                      cursorRow: importItem?.cursorRow ?? 0,
                    })
              }
            />
            <Button
              type="button"
              variant="secondary"
              data-testid="import-progress-cancel"
              onClick={() => void onCancel()}
            >
              {t('contacts.import.progress.cancelButton')}
            </Button>
          </div>
        ) : null}

        {step === 'result' && importItem ? (
          <ImportResult
            item={importItem}
            onDownloadErrors={() => void onDownloadErrors()}
            downloadingErrors={downloadingErrors}
            onClose={() => {
              onOpenChange(false);
              reset();
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
