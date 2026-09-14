import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Presentational loading indicator - no interactive markers, so no
 * `'use client'` directive (blueprint: "purely presentational ones do
 * not"). The caller ALWAYS supplies `aria-label` from `@wp/i18n` (e.g.
 * `t('common.loading')`) - this component never hard-codes copy.
 */
export type SpinnerSize = 'sm' | 'md' | 'lg';

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  'aria-label': string;
  size?: SpinnerSize;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4 border-2',
  md: 'h-5 w-5 border-2',
  lg: 'h-6 w-6 border-2',
};

export function Spinner({
  size = 'md',
  className,
  'aria-label': ariaLabel,
  ...rest
}: SpinnerProps): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={cx(
        'inline-block animate-spin rounded-full border-border border-t-accent',
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  );
}
