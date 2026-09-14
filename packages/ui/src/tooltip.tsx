'use client';

import * as React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { cx } from './lib/cx.js';

/**
 * Tooltip - Base UI Tooltip (ADR 0007). Base UI shows the popup on hover AND
 * on keyboard focus of the trigger (no separate wiring needed here). Carries
 * `'use client'`: renders via Base UI's internal open state.
 */
export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** How long to wait before opening on hover, in ms. @default 600 */
  delay?: number;
}

export function Tooltip({
  content,
  children,
  side = 'top',
  delay,
}: TooltipProps): React.JSX.Element {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} delay={delay} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="outline-none">
          <BaseTooltip.Popup
            className={cx(
              'rounded-md bg-fg px-2 py-1 text-xs font-ui text-bg shadow-md',
              'transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
              'data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            )}
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
