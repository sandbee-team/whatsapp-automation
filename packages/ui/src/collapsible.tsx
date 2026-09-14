'use client';

import * as React from 'react';
import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible';
import { ChevronDown } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Collapsible - Base UI Collapsible (ADR 0007) with a chevron trigger and a
 * height-animated panel (Base UI sets `--collapsible-panel-height` for the
 * transition). Carries `'use client'`: forwards `onOpenChange`.
 */
export interface CollapsibleProps {
  trigger: React.ReactNode;
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Collapsible({
  trigger,
  children,
  open,
  defaultOpen,
  onOpenChange,
}: CollapsibleProps): React.JSX.Element {
  return (
    <BaseCollapsible.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}
    >
      <BaseCollapsible.Trigger
        className={cx(
          'group flex w-full items-center justify-between gap-2 rounded-md py-2 text-left text-sm font-medium text-fg',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
        )}
      >
        {trigger}
        <ChevronDown
          aria-hidden="true"
          size={16}
          className="shrink-0 text-muted transition-transform duration-150 group-data-[panel-open]:rotate-180"
        />
      </BaseCollapsible.Trigger>
      <BaseCollapsible.Panel
        className={cx(
          'overflow-hidden transition-[height] duration-200 ease-standard',
          'h-[var(--collapsible-panel-height)] data-[starting-style]:h-0 data-[ending-style]:h-0',
        )}
      >
        <div className="pb-2 pt-1 text-sm text-muted">{children}</div>
      </BaseCollapsible.Panel>
    </BaseCollapsible.Root>
  );
}
