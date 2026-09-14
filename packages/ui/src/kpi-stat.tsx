import * as React from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { cx } from './lib/cx.js';
import { Skeleton } from './skeleton.js';
import { AnimatedNumber } from './motion.js';

/**
 * KpiStat - a dashboard stat card body: label row (label + icon tile), large
 * value (count-up via `AnimatedNumber` when `numericValue` is given,
 * otherwise the plain `value` string), footer row (delta and/or hint).
 * `loading` renders fixed-height skeleton blocks sized like the final
 * layout, so there is no layout shift on load. Purely presentational, no
 * `'use client'` (the interactive count-up lives in `motion.tsx`).
 */
export type KpiStatDeltaDirection = 'up' | 'down' | 'flat';
export type KpiStatTone = 'accent' | 'info' | 'success' | 'warning' | 'danger';

export interface KpiStatDelta {
  text: string;
  direction: KpiStatDeltaDirection;
}

export interface KpiStatProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string;
  /** When supplied, the value counts up to this number on mount instead of rendering `value` verbatim. */
  numericValue?: number;
  hint?: string;
  delta?: KpiStatDelta;
  icon?: React.ReactNode;
  /** Icon tile colour pair. Default `accent`. */
  tone?: KpiStatTone;
  loading?: boolean;
}

const DELTA_TONE_CLASSES: Record<KpiStatDeltaDirection, string> = {
  up: 'text-success',
  down: 'text-danger',
  flat: 'text-muted',
};

const DELTA_ICONS: Record<KpiStatDeltaDirection, typeof ArrowUp> = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
};

const TONE_TILE_CLASSES: Record<KpiStatTone, string> = {
  accent: 'bg-accent-soft text-accent',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};

export function KpiStat({
  label,
  value,
  numericValue,
  hint,
  delta,
  icon,
  tone = 'accent',
  loading = false,
  className,
  ...rest
}: KpiStatProps): React.JSX.Element {
  const DeltaIcon = delta ? DELTA_ICONS[delta.direction] : null;

  return (
    <div className={cx('flex flex-col gap-2', className)} {...rest}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-ui text-muted">{label}</span>
        {icon ? (
          <span
            aria-hidden="true"
            className={cx(
              'flex h-9 w-9 items-center justify-center rounded-lg',
              TONE_TILE_CLASSES[tone],
            )}
          >
            {icon}
          </span>
        ) : null}
      </div>
      {loading ? (
        <>
          <Skeleton data-testid="kpi-stat-skeleton" className="h-8 w-24" />
          <Skeleton data-testid="kpi-stat-skeleton" className="h-4 w-32" />
        </>
      ) : (
        <>
          <span className="font-ui text-3xl font-semibold tracking-tight tabular-nums text-fg">
            {numericValue === undefined ? value : <AnimatedNumber value={numericValue} />}
          </span>
          <div className="flex h-4 items-center gap-3 text-xs font-ui">
            {delta ? (
              <span
                data-testid="kpi-stat-delta"
                className={cx(
                  'inline-flex items-center gap-1',
                  DELTA_TONE_CLASSES[delta.direction],
                )}
              >
                {DeltaIcon ? <DeltaIcon aria-hidden="true" size={12} /> : null}
                {delta.text}
              </span>
            ) : null}
            {hint ? <span className="text-muted">{hint}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}
