import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Kbd - a presentational keyboard-shortcut chip (`<kbd>`), e.g. the "Ctrl K"
 * hint next to the command palette trigger. No event handlers, so no
 * `'use client'` directive.
 */
export type KbdProps = React.HTMLAttributes<HTMLElement>;

export function Kbd({ className, children, ...rest }: KbdProps): React.JSX.Element {
  return (
    <kbd
      className={cx(
        'inline-flex items-center justify-center rounded border border-border-strong',
        'bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted',
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
