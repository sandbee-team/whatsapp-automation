import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * EmptyState - icon slot (48px rounded-full ring), title, body, primary +
 * optional secondary action, `compact` variant for use inside a card. Purely
 * presentational (no event handlers of its own - `action`/`secondaryAction`
 * are caller-supplied nodes, e.g. a `<Button>`), so no `'use client'`
 * directive.
 */
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** Denser padding/gaps for use inside a Card. */
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
  secondaryAction,
  compact = false,
  className,
  ...rest
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-border text-center',
        compact ? 'p-6' : 'p-8',
        className,
      )}
      {...rest}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-2 text-muted ring-1 ring-border"
        >
          {icon}
        </div>
      ) : null}
      <h2 className="text-base font-semibold font-ui text-fg">{title}</h2>
      {body ? <p className="max-w-prose text-sm font-ui text-muted">{body}</p> : null}
      {action || secondaryAction ? (
        <div className="flex items-center gap-2 pt-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
