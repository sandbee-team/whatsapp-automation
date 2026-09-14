import * as React from 'react';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { cx } from './lib/cx.js';

/**
 * Progress - Base UI Progress (ADR 0007): a labelled bar with a caller-
 * supplied value-text string (e.g. "40 of 100 contacts imported"). Purely
 * presentational composition of Base UI parts driven by props, so no
 * `'use client'` directive is required (no local state/hooks/DOM events of
 * its own).
 */
export interface ProgressProps {
  /** Current value; `null` renders an indeterminate bar. */
  value: number | null;
  max?: number;
  label: string;
  /** Human-readable value text, e.g. "40 of 100 contacts imported". */
  valueText: string;
}

export function Progress({ value, max = 100, label, valueText }: ProgressProps): React.JSX.Element {
  return (
    <BaseProgress.Root value={value} max={max} aria-valuetext={valueText} className="w-full">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <BaseProgress.Label className="text-sm font-medium text-fg">{label}</BaseProgress.Label>
        <BaseProgress.Value className="text-sm text-muted">{() => valueText}</BaseProgress.Value>
      </div>
      <BaseProgress.Track className="h-2 overflow-hidden rounded-full bg-surface-2">
        <BaseProgress.Indicator
          className={cx('h-full rounded-full bg-accent transition-all duration-200')}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
  );
}
