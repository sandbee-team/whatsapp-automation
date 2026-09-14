import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Skeleton / SkeletonText / SkeletonRows - presentational loading
 * placeholders, always `aria-hidden` (the caller's real `Spinner`/`role`
 * region carries the "loading" announcement; a skeleton is a layout
 * placeholder, not a status message). No `'use client'` directive.
 */
export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...rest }: SkeletonProps): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'relative overflow-hidden rounded-md bg-surface-2',
        'after:absolute after:inset-0 after:bg-gradient-to-r after:from-transparent after:via-surface/60 after:to-transparent',
        'after:animate-shimmer motion-reduce:after:animate-none',
        className,
      )}
      {...rest}
    />
  );
}

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of text lines to render. Default 1. */
  lines?: number;
}

export function SkeletonText({
  lines = 1,
  className,
  ...rest
}: SkeletonTextProps): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cx('flex flex-col gap-2', className)} {...rest}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cx('h-3', index === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full')}
        />
      ))}
    </div>
  );
}

export interface SkeletonRowsProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of table rows to render. */
  rows: number;
  /** Number of cell columns per row. */
  columns: number;
}

export function SkeletonRows({
  rows,
  columns,
  className,
  ...rest
}: SkeletonRowsProps): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cx('flex flex-col gap-2', className)} {...rest}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="flex h-11 items-center gap-4">
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}
