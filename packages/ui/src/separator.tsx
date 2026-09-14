import * as React from 'react';
import { Separator as BaseSeparator } from '@base-ui/react/separator';
import { cx } from './lib/cx.js';

/**
 * Separator - Base UI Separator (`role="separator"` + `aria-orientation`
 * are set by Base UI itself), horizontal or vertical, with an optional
 * centred label (renders as two separator segments flanking the text).
 * Purely presentational, no `'use client'` directive.
 */
export type SeparatorOrientation = 'horizontal' | 'vertical';

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: SeparatorOrientation;
  /** Optional centred text, e.g. "or". Only meaningful for horizontal separators. */
  label?: string;
}

export function Separator({
  orientation = 'horizontal',
  label,
  className,
  ...rest
}: SeparatorProps): React.JSX.Element {
  if (label) {
    return (
      <div className={cx('flex items-center gap-3', className)}>
        <BaseSeparator orientation={orientation} className="h-px flex-1 bg-border" {...rest} />
        <span className="text-xs font-ui text-muted">{label}</span>
        <BaseSeparator orientation={orientation} className="h-px flex-1 bg-border" />
      </div>
    );
  }

  return (
    <BaseSeparator
      orientation={orientation}
      className={cx(
        orientation === 'vertical' ? 'w-px self-stretch' : 'h-px w-full',
        'bg-border',
        className,
      )}
      {...rest}
    />
  );
}
