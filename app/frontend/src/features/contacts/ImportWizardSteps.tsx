'use client';

import * as React from 'react';
import {
  Button,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  useT,
  useLocale,
  type SelectOption,
} from '@wp/ui';
import { CONTACTS_COPY } from '@wp/domain';
import type { UploadImportResult } from './api.js';

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const ATTR_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** Upload step - client-side rejects > 16 MiB and non-CSV BEFORE ever calling the network. */
export interface UploadStepProps {
  onFileSelected: (file: File) => void;
  error: string | null;
  uploading: boolean;
}

export function UploadStep({
  onFileSelected,
  error,
  uploading,
}: UploadStepProps): React.JSX.Element {
  const t = useT();
  const inputId = React.useId();

  const onChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    onFileSelected(file);
  };

  return (
    <div data-testid="import-step-upload" className="flex flex-col gap-4">
      <label htmlFor={inputId} className="text-sm font-medium font-ui text-fg">
        {t('contacts.import.upload.label')}
      </label>
      <p className="text-sm font-ui text-muted">{t('contacts.import.upload.description')}</p>
      <input
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        data-testid="import-upload-input"
        disabled={uploading}
        onChange={onChange}
      />
      {error ? (
        <p role="alert" data-testid="import-upload-error" className="text-sm font-ui text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Validates a chosen file client-side; returns an i18n error key, or null when it may be uploaded. */
export function validateUploadFile(
  file: File,
): 'contacts.import.tooLarge' | 'contacts.import.notCsv' | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'contacts.import.tooLarge';
  const isCsvType = file.type === 'text/csv' || file.type === '';
  const isCsvName = file.name.toLowerCase().endsWith('.csv');
  if (!isCsvType || !isCsvName) return 'contacts.import.notCsv';
  return null;
}

export interface AttrMappingRow {
  key: string;
  column: string;
}

/** Mapping + preview step - phone column required, name optional, up to 20 attr columns. */
export interface MappingStepProps {
  upload: UploadImportResult;
  phoneColumn: string;
  onPhoneColumnChange: (value: string) => void;
  nameColumn: string;
  onNameColumnChange: (value: string) => void;
  defaultCountry: string;
  onDefaultCountryChange: (value: string) => void;
  attrRows: AttrMappingRow[];
  onAttrRowsChange: (rows: AttrMappingRow[]) => void;
  onContinue: () => void;
}

export function MappingStep({
  upload,
  phoneColumn,
  onPhoneColumnChange,
  nameColumn,
  onNameColumnChange,
  defaultCountry,
  onDefaultCountryChange,
  attrRows,
  onAttrRowsChange,
  onContinue,
}: MappingStepProps): React.JSX.Element {
  const t = useT();

  const addAttrRow = (): void => {
    if (attrRows.length >= 20) return;
    onAttrRowsChange([...attrRows, { key: '', column: upload.columns[0] ?? '' }]);
  };

  const updateAttrRow = (index: number, patch: Partial<AttrMappingRow>): void => {
    onAttrRowsChange(attrRows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const invalidAttrKey = attrRows.some(
    (row) => row.key.length > 0 && !ATTR_KEY_PATTERN.test(row.key),
  );

  const columnOptions: SelectOption[] = upload.columns.map((column) => ({
    value: column,
    label: column,
  }));
  // Name is optional: an explicit empty-value option keeps the "—" clear
  // choice the native <select> offered (never dropping back to placeholder
  // being the only way to represent "no name column").
  const nameColumnOptions: SelectOption[] = [{ value: '', label: '—' }, ...columnOptions];

  return (
    <div data-testid="import-step-mapping" className="flex flex-col gap-4">
      <div data-testid="import-mapping-phone">
        <Select
          label={t('contacts.import.mapping.phoneLabel')}
          placeholder={t('contacts.import.mapping.phoneLabel')}
          options={columnOptions}
          value={phoneColumn || null}
          onValueChange={onPhoneColumnChange}
        />
      </div>

      <div data-testid="import-mapping-name">
        <Select
          label={t('contacts.import.mapping.nameLabel')}
          placeholder={t('contacts.import.mapping.nameLabel')}
          options={nameColumnOptions}
          value={nameColumn}
          onValueChange={onNameColumnChange}
        />
      </div>

      <Input
        label={t('contacts.import.mapping.countryLabel')}
        data-testid="import-mapping-country"
        value={defaultCountry}
        onChange={(event) => onDefaultCountryChange(event.target.value)}
      />

      <div className="flex flex-col gap-2">
        {attrRows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              label={t('contacts.import.mapping.attrKeyLabel')}
              value={row.key}
              data-testid={`import-mapping-attr-key-${index}`}
              onChange={(event) => updateAttrRow(index, { key: event.target.value })}
            />
            <div data-testid={`import-mapping-attr-column-${index}`}>
              <Select
                label={t('contacts.import.mapping.attrColumnLabel')}
                placeholder={t('contacts.import.mapping.attrColumnLabel')}
                options={columnOptions}
                value={row.column || null}
                onValueChange={(column) => updateAttrRow(index, { column })}
              />
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="import-mapping-add-attr"
          onClick={addAttrRow}
        >
          {t('contacts.import.mapping.addAttrButton')}
        </Button>
      </div>

      <h3 className="text-sm font-semibold font-ui text-fg">
        {t('contacts.import.mapping.previewTitle')}
      </h3>
      <Table caption={t('contacts.import.mapping.previewTitle')}>
        <THead>
          <TR>
            {upload.columns.map((column) => (
              <TH key={column}>{column}</TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {upload.preview.map((row, rowIndex) => (
            <TR key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <TD key={cellIndex}>{cell}</TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>

      <Button
        type="button"
        data-testid="import-mapping-continue"
        disabled={phoneColumn.length === 0 || invalidAttrKey}
        onClick={onContinue}
      >
        {t('contacts.import.mapping.continueButton')}
      </Button>
    </div>
  );
}

/** Attestation step - the verbatim notice, a required checkbox, and a required free-text source (>= 3 chars). */
export interface AttestationStepProps {
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  sourceText: string;
  onSourceTextChange: (value: string) => void;
  onStart: () => void;
  starting: boolean;
}

export function AttestationStep({
  accepted,
  onAcceptedChange,
  sourceText,
  onSourceTextChange,
  onStart,
  starting,
}: AttestationStepProps): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const checkboxId = React.useId();
  const sourceId = React.useId();
  const canStart = accepted && sourceText.trim().length >= 3;

  return (
    <div data-testid="import-step-attestation" className="flex flex-col gap-4">
      <p data-testid="import-attestation-notice" className="text-sm font-ui text-fg">
        {CONTACTS_COPY.attestationNotice}
      </p>
      {locale === 'hi' ? (
        <p data-testid="import-attestation-notice-hi" className="text-sm font-ui text-fg">
          {t('contacts.import.attestationNoticeHi')}
        </p>
      ) : null}

      <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm font-ui text-fg">
        <input
          id={checkboxId}
          type="checkbox"
          data-testid="import-attestation-checkbox"
          checked={accepted}
          onChange={(event) => onAcceptedChange(event.target.checked)}
        />
        {t('contacts.import.attestationCheckbox')}
      </label>

      <label htmlFor={sourceId} className="text-sm font-medium font-ui text-fg">
        {t('contacts.import.attestationSourceLabel')}
      </label>
      <textarea
        id={sourceId}
        data-testid="import-attestation-source"
        value={sourceText}
        onChange={(event) => onSourceTextChange(event.target.value)}
      />

      <Button
        type="button"
        data-testid="import-attestation-start"
        disabled={!canStart}
        loading={starting}
        loadingLabel={t('common.loading')}
        onClick={onStart}
      >
        {t('contacts.import.startButton')}
      </Button>
    </div>
  );
}
