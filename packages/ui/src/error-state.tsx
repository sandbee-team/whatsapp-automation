import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * ErrorState - a `role="status"` region (NOT `role="alert"`: an error page
 * state is not an urgent interruption, it is a rendered page - `alert` is
 * reserved for banners announced mid-flow, see `Alert`). Purely
 * presentational (no event handlers of its own - `retryAction` is a
 * caller-supplied node, e.g. a retry `<Button>` wired to `refetch` by the
 * caller), so no `'use client'` directive.
 */
export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  body?: string;
  retryAction?: React.ReactNode;
  /** Raw diagnostic text (e.g. a request id), rendered in a monospace block. */
  details?: string;
}

export function ErrorState({
  title,
  body,
  retryAction,
  details,
  className,
  ...rest
}: ErrorStateProps): React.JSX.Element {
  return (
    <div
      role="status"
      className={cx(
        'flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-8 text-center',
        className,
      )}
      {...rest}
    >
      <h2 className="text-base font-semibold font-ui text-fg">{title}</h2>
      {body ? <p className="max-w-prose text-sm font-ui text-muted">{body}</p> : null}
      {retryAction ? <div className="pt-2">{retryAction}</div> : null}
      {details ? (
        <pre className="mt-2 max-w-full overflow-x-auto rounded-md bg-surface-2 px-3 py-2 text-left text-xs font-mono text-muted">
          {details}
        </pre>
      ) : null}
    </div>
  );
}
