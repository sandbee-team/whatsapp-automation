import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Label - standalone label for a form control, with an optional hint slot
 * (e.g. "Optional") rendered inline in muted text. Purely presentational (no
 * hooks, no DOM event props of its own beyond the ones the caller forwards),
 * so no `'use client'` directive.
 */
export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** Inline hint rendered after the label text, e.g. "Optional". */
  hint?: React.ReactNode;
}

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { hint, className, children, ...rest },
  ref,
) {
  return (
    <label ref={ref} className={cx('text-sm font-medium font-ui text-fg', className)} {...rest}>
      {children}
      {hint ? <span className="ml-1 font-normal text-muted">{hint}</span> : null}
    </label>
  );
});
