import * as React from 'react';
import { Textarea, useT } from '@wp/ui';

/**
 * reason-field.tsx (P28 Unit U6, step 9) - the mandatory staff reason
 * textarea every mutation dialog carries (`adminMutationReasonSchema`:
 * `min(3).max(500)`). A live character counter, no hard-coded copy beyond
 * `@wp/i18n` keys.
 */
const MIN_LENGTH = 3;
const MAX_LENGTH = 500;

export interface ReasonFieldProps {
  value: string;
  onChange: (value: string) => void;
  'data-testid'?: string;
}

export function isReasonValid(value: string): boolean {
  return value.trim().length >= MIN_LENGTH;
}

export function ReasonField({
  value,
  onChange,
  'data-testid': testId,
}: ReasonFieldProps): React.JSX.Element {
  const t = useT();
  return (
    <Textarea
      label={t('admin.common.reasonLabel')}
      description={t('admin.common.reasonDescription')}
      data-testid={testId ?? 'reason-field'}
      value={value}
      maxLength={MAX_LENGTH}
      counterLabel={(count, max) => `${String(count)}/${String(max)}`}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
