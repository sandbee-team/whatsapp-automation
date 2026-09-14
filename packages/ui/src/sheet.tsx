'use client';

import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Sheet - a side panel built on Base UI's Dialog (ADR 0007: "Primitives:
 * Base UI (headless) + shadcn-style copy-in components we art-direct").
 * Base UI's Dialog provides the focus trap and Escape-to-close behaviour;
 * this component wires `aria-labelledby`/`aria-describedby` to the title/
 * description ids explicitly (rather than relying on implicit association)
 * so the requirement is provable by reading the DOM. Carries `'use client'`:
 * uses `onOpenChange`/state internally via Base UI's controlled `open` prop.
 *
 * Backward-compatible: keeps {open, onOpenChange, title, description?,
 * children?, closeLabel}; adds `side` (default 'right'), `size` and `footer`.
 */
export type SheetSide = 'left' | 'right' | 'bottom';
export type SheetSize = 'sm' | 'md' | 'lg';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  /** Accessible label for the close button (from `@wp/i18n`, e.g. `t('common.close')`). */
  closeLabel: string;
  /** Edge the sheet slides in from. @default 'right' */
  side?: SheetSide;
  /** Cross-axis size (width for left/right, height for bottom). @default 'md' */
  size?: SheetSize;
  footer?: React.ReactNode;
}

const SIDE_POSITION_CLASSES: Record<SheetSide, string> = {
  right: 'inset-y-0 right-0 border-l',
  left: 'inset-y-0 left-0 border-r',
  bottom: 'inset-x-0 bottom-0 border-t max-h-[85vh]',
};

const SIDE_ANIMATION_CLASSES: Record<SheetSide, string> = {
  right:
    'data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full transition-transform',
  left: 'data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full transition-transform',
  bottom:
    'data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full transition-transform',
};

const SIDE_SIZE_CLASSES: Record<SheetSide, Record<SheetSize, string>> = {
  right: { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' },
  left: { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg' },
  bottom: { sm: 'h-[40vh]', md: 'h-[60vh]', lg: 'h-[80vh]' },
};

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  closeLabel,
  side = 'right',
  size = 'md',
  footer,
}: SheetProps): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const isBottom = side === 'bottom';

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)} modal>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cx(
            'fixed inset-0 bg-overlay',
            'transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <Dialog.Popup
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className={cx(
            'fixed flex flex-col gap-4 border-border bg-surface p-6 font-ui text-fg shadow-lg',
            isBottom ? 'w-full' : 'h-full w-full',
            SIDE_POSITION_CLASSES[side],
            SIDE_ANIMATION_CLASSES[side],
            'duration-200',
            SIDE_SIZE_CLASSES[side][size],
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title id={titleId} className="text-lg font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={closeLabel}
              className={cx(
                'rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'focus-visible:ring-offset-2 ring-offset-bg',
              )}
            >
              <X aria-hidden="true" size={16} />
            </Dialog.Close>
          </div>
          {description ? (
            <Dialog.Description id={descriptionId} className="text-sm text-muted">
              {description}
            </Dialog.Description>
          ) : null}
          <div className="flex-1 overflow-y-auto">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
              {footer}
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
