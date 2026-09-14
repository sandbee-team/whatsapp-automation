'use client';

import * as React from 'react';
import { cx } from '../lib/cx.js';
import { clampPercent, TONE_STROKE, type ChartTone } from './chart-support.js';

/**
 * ProgressRing - a single-value radial gauge (fleet health score, onboarding
 * checklist progress, wizard "done" ring). Draws a track circle plus a value
 * arc that animates from 0 to its final `stroke-dashoffset` on mount via a
 * CSS transition (`motion-reduce:transition-none` disables it); the FINAL
 * value is what tests assert (no need to await the transition). `role="img"`
 * with the caller-supplied `label` carries the accessible meaning - the arc
 * itself is decorative. `'use client'`: animates via `useState`/`useEffect`.
 */
export type ProgressRingSize = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<ProgressRingSize, number> = { sm: 64, md: 96, lg: 128 };

export interface ProgressRingProps {
  /** Percentage 0-100 the arc represents. */
  value: number;
  size?: ProgressRingSize;
  /** Stroke width in px. Default 8. */
  thickness?: number;
  tone?: ChartTone;
  /** Accessible label describing the value, e.g. "Fleet health 82 of 100". */
  label: string;
  /** Optional content centred inside the ring (e.g. "82"). */
  children?: React.ReactNode;
  className?: string;
}

export function ProgressRing({
  value,
  size = 'md',
  thickness = 8,
  tone = 'accent',
  label,
  children,
  className,
}: ProgressRingProps): React.JSX.Element {
  const dimension = SIZE_PX[size];
  const radius = dimension / 2 - thickness / 2;
  const circumference = 2 * Math.PI * radius;
  const percent = clampPercent(value);
  const targetOffset = circumference * (1 - percent / 100);

  const [offset, setOffset] = React.useState(circumference);
  React.useEffect(() => {
    setOffset(targetOffset);
  }, [targetOffset]);

  const center = dimension / 2;

  return (
    <span
      role="img"
      aria-label={label}
      className={cx('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: dimension, height: dimension }}
    >
      <svg
        width={dimension}
        height={dimension}
        viewBox={`0 0 ${dimension} ${dimension}`}
        aria-hidden="true"
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          className="stroke-surface-2"
        />
        <circle
          data-testid="progress-ring-arc"
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          className={cx(
            TONE_STROKE[tone],
            'origin-center -rotate-90 transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none',
          )}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 flex items-center justify-center">{children}</span>
      ) : null}
    </span>
  );
}
