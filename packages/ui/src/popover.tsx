'use client';

import * as React from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { cx } from './lib/cx.js';

/**
 * Popover - Base UI Popover (ADR 0007) with an optional title/description
 * header and an arrow pointing at the trigger. Base UI provides the focus
 * trap, Escape-to-close and outside-press-to-close behaviour. Carries
 * `'use client'`: renders via controlled/uncontrolled open state.
 */
export interface PopoverProps {
  trigger: React.ReactElement;
  title?: string;
  description?: string;
  children?: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({
  trigger,
  title,
  description,
  children,
  side = 'bottom',
  align = 'center',
  open,
  onOpenChange,
}: PopoverProps): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();

  return (
    <BasePopover.Root
      open={open}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
    >
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={8} className="outline-none">
          <BasePopover.Popup
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            className={cx(
              'w-72 rounded-lg border border-border bg-surface p-4 font-ui text-fg shadow-md',
              'transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
              'data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            <BasePopover.Arrow className="fill-surface">
              <ArrowSvg />
            </BasePopover.Arrow>
            {title ? (
              <p id={titleId} className="text-sm font-semibold">
                {title}
              </p>
            ) : null}
            {description ? (
              <p id={descriptionId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
            {children ? (
              <div className={title || description ? 'mt-3' : undefined}>{children}</div>
            ) : null}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

function ArrowSvg(): React.JSX.Element {
  return (
    <svg width="12" height="6" viewBox="0 0 12 6" aria-hidden="true">
      <path d="M0 0 L6 6 L12 0" className="fill-surface stroke-border" strokeWidth={1} />
    </svg>
  );
}
