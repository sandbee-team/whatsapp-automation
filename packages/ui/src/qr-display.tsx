import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * QrDisplay - presentational: a framed tile around a QR image (data URL or
 * inline SVG string used as an `<img src>`). No `'use client'` (no hooks, no
 * DOM event props). `expired` dims the image and shows `expiredOverlay` on
 * top; `footer` is a slot for a countdown ring or similar. Alt text always
 * comes from `label` (no copy hard-coded in this package).
 */
export interface QrDisplayProps {
  /** Data URL or inline SVG string. */
  src: string;
  size?: number;
  label: string;
  expired?: boolean;
  expiredOverlay?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function QrDisplay({
  src,
  size = 240,
  label,
  expired = false,
  expiredOverlay,
  footer,
  className,
}: QrDisplayProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm',
        className,
      )}
    >
      <div className="relative">
        <img
          src={src}
          alt={label}
          width={size}
          height={size}
          className={cx('rounded-md', expired && 'opacity-30')}
        />
        {expired && expiredOverlay ? (
          <div className="absolute inset-0 flex items-center justify-center p-2 text-center">
            {expiredOverlay}
          </div>
        ) : null}
      </div>
      {footer ? <div className="flex items-center justify-center">{footer}</div> : null}
    </div>
  );
}
