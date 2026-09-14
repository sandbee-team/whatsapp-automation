import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * StatusDot - an 8px tone dot that NEVER signals status by colour alone: a
 * `label` is required and rendered as text, visually hidden by default
 * (`hideLabel` defaults to true) so a caller that already shows the status
 * word elsewhere can opt into a visible label instead. Purely presentational
 * (no event handlers), so no `'use client'` directive.
 */
export type StatusDotTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  /** Accessible/visible status text, e.g. "Live", "Offline", "Degraded". */
  label: string;
  /** When true (default) the label is visually hidden but stays in the a11y tree. */
  hideLabel?: boolean;
  /** Animates the dot to signal a live/active state. */
  pulse?: boolean;
}

const TONE_DOT_CLASSES: Record<StatusDotTone, string> = {
  neutral: 'bg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

export const StatusDot = React.forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { tone = 'neutral', label, hideLabel = true, pulse = false, className, ...rest },
  ref,
) {
  return (
    <span ref={ref} className={cx('inline-flex items-center gap-1.5', className)} {...rest}>
      <span
        data-testid="status-dot-indicator"
        aria-hidden="true"
        className={cx(
          'h-2 w-2 shrink-0 rounded-full',
          TONE_DOT_CLASSES[tone],
          pulse && 'animate-pulse',
        )}
      />
      <span className={cx('text-xs font-ui', !hideLabel && 'text-muted', hideLabel && 'sr-only')}>
        {label}
      </span>
    </span>
  );
});
