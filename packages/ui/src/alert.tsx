'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Alert - an inline banner (not a toast). `role="status"` for
 * neutral/info/success (informational, not urgent) and `role="alert"` for
 * warning/danger (needs immediate attention). Carries `'use client'`: the
 * optional dismiss button forwards `onClick`.
 */
export type AlertTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  tone: AlertTone;
  title: string;
  body?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  /** Accessible label for the dismiss button. Required whenever `onDismiss` is given. */
  dismissLabel?: string;
}

const TONE_CLASSES: Record<AlertTone, string> = {
  neutral: 'border-border bg-surface-2 text-fg',
  success: 'border-success bg-success-soft text-success',
  warning: 'border-warning bg-warning-soft text-warning',
  danger: 'border-danger bg-danger-soft text-danger',
  info: 'border-info bg-info-soft text-info',
};

const ALERT_ROLE_TONES: ReadonlySet<AlertTone> = new Set<AlertTone>(['warning', 'danger']);

export function Alert({
  tone,
  title,
  body,
  icon,
  action,
  onDismiss,
  dismissLabel,
  className,
  ...rest
}: AlertProps): React.JSX.Element {
  const role = ALERT_ROLE_TONES.has(tone) ? 'alert' : 'status';

  return (
    <div
      role={role}
      className={cx(
        'flex items-start gap-3 rounded-lg border p-4 font-ui',
        TONE_CLASSES[tone],
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="mt-0.5 shrink-0">
          {icon}
        </span>
      ) : null}
      <div className="flex-1 text-sm">
        <p className="font-medium">{title}</p>
        {body ? <p className="mt-1 text-fg/80">{body}</p> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          className={cx(
            'shrink-0 rounded-md p-1 text-current/70 hover:text-current',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
          )}
        >
          <X aria-hidden="true" size={16} />
        </button>
      ) : null}
    </div>
  );
}
