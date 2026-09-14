import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Badge - tones neutral/success/warning/danger/info/accent, rendered as a
 * soft tint (never a solid fill) so it reads as a label, not a button. Tone
 * alone is never the only signal: callers must pair it with text
 * (accessibility rule: no color-only state signaling) - this component
 * always renders its children as text content. Purely presentational, no
 * `'use client'`.
 */
export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Renders a status dot before the text (in addition to it, never instead). */
  dot?: boolean;
  /** Optional leading icon, rendered `aria-hidden` (the text carries the meaning). */
  icon?: React.ReactNode;
}

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-muted',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  accent: 'bg-accent-soft text-accent',
};

/** Dot fill colour per tone - the dot is `aria-hidden`; the badge's own text
 * content is the accessible status signal (never colour/dot alone). */
const TONE_DOT_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'h-5 gap-1 px-1.5 text-xs',
  md: 'h-6 gap-1.5 px-2 text-sm',
};

export function Badge({
  tone = 'neutral',
  size = 'md',
  dot = false,
  icon,
  className,
  children,
  ...rest
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full font-medium font-ui',
        TONE_CLASSES[tone],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {dot ? (
        <span
          data-testid="status-dot-indicator"
          aria-hidden="true"
          className={cx('h-2 w-2 shrink-0 rounded-full', TONE_DOT_CLASSES[tone])}
        />
      ) : null}
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
