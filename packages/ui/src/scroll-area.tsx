import * as React from 'react';
import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';
import { cx } from './lib/cx.js';

/**
 * ScrollArea - Base UI ScrollArea (ADR 0007) with a styled scrollbar/thumb.
 * Purely compositional (no local hooks/handlers of its own - Base UI owns
 * the scroll tracking), so no `'use client'` directive.
 */
export interface ScrollAreaProps {
  children?: React.ReactNode;
  /** Caps the viewport height so overflow scrolls instead of growing the page. */
  maxHeight?: string;
  className?: string;
}

export function ScrollArea({ children, maxHeight, className }: ScrollAreaProps): React.JSX.Element {
  return (
    <BaseScrollArea.Root
      className={cx('overflow-hidden', className)}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <BaseScrollArea.Viewport className="h-full w-full">{children}</BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-2 touch-none select-none p-0.5 transition-opacity duration-150 data-[hovering]:opacity-100"
      >
        <BaseScrollArea.Thumb className="flex-1 rounded-full bg-border-strong" />
      </BaseScrollArea.Scrollbar>
      <BaseScrollArea.Scrollbar
        orientation="horizontal"
        className="flex h-2 touch-none select-none p-0.5 transition-opacity duration-150 data-[hovering]:opacity-100"
      >
        <BaseScrollArea.Thumb className="flex-1 rounded-full bg-border-strong" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}
