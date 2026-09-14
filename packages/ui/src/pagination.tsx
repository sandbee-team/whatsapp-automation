'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Pagination - standalone numbered pager (also used by `DataTable`'s
 * client-pagination footer). Carries `'use client'`: forwards `onClick`.
 * Long ranges collapse to first/last + a window around the current page
 * with `…` separators (never focusable, `aria-hidden`).
 */
export interface PaginationLabels {
  previous: string;
  next: string;
  page: (n: number) => string;
}

export interface PaginationProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** Current page, 1-indexed. */
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  labels: PaginationLabels;
}

const SIBLING_COUNT = 1;

type PageToken = number | 'ellipsis-start' | 'ellipsis-end';

function buildPageRange(page: number, pageCount: number): PageToken[] {
  const totalVisible = SIBLING_COUNT * 2 + 5;
  if (pageCount <= totalVisible) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const leftSibling = Math.max(page - SIBLING_COUNT, 1);
  const rightSibling = Math.min(page + SIBLING_COUNT, pageCount);
  const showLeftEllipsis = leftSibling > 2;
  const showRightEllipsis = rightSibling < pageCount - 1;

  const tokens: PageToken[] = [1];
  if (showLeftEllipsis) {
    tokens.push('ellipsis-start');
  } else {
    for (let p = 2; p < leftSibling; p += 1) tokens.push(p);
  }
  for (let p = leftSibling; p <= rightSibling; p += 1) {
    if (p !== 1 && p !== pageCount) tokens.push(p);
  }
  if (showRightEllipsis) {
    tokens.push('ellipsis-end');
  } else {
    for (let p = rightSibling + 1; p < pageCount; p += 1) tokens.push(p);
  }
  tokens.push(pageCount);
  return tokens;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  labels,
  className,
  ...rest
}: PaginationProps): React.JSX.Element {
  const tokens = buildPageRange(page, pageCount);

  return (
    <nav className={cx('flex items-center gap-1', className)} {...rest}>
      <button
        type="button"
        className={cx(
          'inline-flex h-8 items-center rounded-md px-3 text-sm font-ui text-fg',
          'hover:bg-surface-2 disabled:opacity-50 disabled:pointer-events-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 ring-offset-bg',
        )}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {labels.previous}
      </button>
      {tokens.map((token) => {
        if (token === 'ellipsis-start' || token === 'ellipsis-end') {
          return (
            <span key={token} aria-hidden="true" className="px-1 text-sm text-subtle">
              …
            </span>
          );
        }
        const isCurrent = token === page;
        return (
          <button
            key={token}
            type="button"
            aria-current={isCurrent ? 'page' : undefined}
            className={cx(
              'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-ui',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 ring-offset-bg',
              isCurrent ? 'bg-accent-soft text-accent font-medium' : 'text-fg hover:bg-surface-2',
            )}
            onClick={() => onPageChange(token)}
          >
            {labels.page(token)}
          </button>
        );
      })}
      <button
        type="button"
        className={cx(
          'inline-flex h-8 items-center rounded-md px-3 text-sm font-ui text-fg',
          'hover:bg-surface-2 disabled:opacity-50 disabled:pointer-events-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-2 ring-offset-bg',
        )}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        {labels.next}
      </button>
    </nav>
  );
}
