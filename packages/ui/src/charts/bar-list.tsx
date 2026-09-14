'use client';

import * as React from 'react';
import { cx } from '../lib/cx.js';
import { clampPercent, TONE_BG, type ChartTone } from './chart-support.js';

/**
 * BarList - a horizontal-bar ranking (e.g. "Sending today" per number):
 * leading slot + label + right-aligned value, with a track/fill bar below.
 * Each row is a `role="listitem"`; the fill is a `role="progressbar"` with
 * `aria-valuenow/min/max` (colour is never the only signal - the value text
 * and the aria attributes both carry it). `'use client'`: bars animate their
 * width in on mount.
 */
export interface BarListRow {
  id: string;
  label: string;
  value: number;
  max: number;
  tone?: ChartTone;
  meta?: React.ReactNode;
  leading?: React.ReactNode;
  href?: string;
}

export interface BarListProps {
  rows: BarListRow[];
  /** Formats the right-aligned value text. Defaults to "{value}/{max}". */
  valueFormatter?: (value: number, max: number) => string;
  /** Rendered instead of the list when `rows` is empty. */
  emptyMessage?: React.ReactNode;
  className?: string;
}

function defaultFormatter(value: number, max: number): string {
  return `${value}/${max}`;
}

function widthPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return clampPercent((value / max) * 100);
}

export function BarList({
  rows,
  valueFormatter = defaultFormatter,
  emptyMessage,
  className,
}: BarListProps): React.JSX.Element {
  const [drawn, setDrawn] = React.useState(false);
  React.useEffect(() => {
    setDrawn(true);
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className={cx('text-sm text-muted', className)}>
        {emptyMessage ?? 'Nothing to show yet.'}
      </div>
    );
  }

  return (
    <ul role="list" className={cx('flex flex-col gap-4', className)}>
      {rows.map((row) => {
        const tone = row.tone ?? 'accent';
        const percent = widthPercent(row.value, row.max);
        const content = (
          <>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                {row.leading ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {row.leading}
                  </span>
                ) : null}
                <span className="truncate font-medium text-fg">{row.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted">
                {valueFormatter(row.value, row.max)}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                role="progressbar"
                aria-label={row.label}
                aria-valuenow={row.value}
                aria-valuemin={0}
                aria-valuemax={row.max}
                className={cx(
                  'h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none',
                  TONE_BG[tone],
                )}
                style={{ width: `${drawn ? percent : 0}%` }}
              />
            </div>
            {row.meta ? <div className="text-xs text-muted">{row.meta}</div> : null}
          </>
        );

        return (
          <li key={row.id} className="flex flex-col gap-1.5">
            {row.href ? (
              <a href={row.href} className="flex flex-col gap-1.5 rounded-md hover:opacity-90">
                {content}
              </a>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}
