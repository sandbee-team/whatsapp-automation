'use client';

import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Dialog - centred modal on Base UI's Dialog (ADR 0007). Base UI provides the
 * focus trap, Escape-to-close and outside-press-to-close behaviour; this
 * component wires `aria-labelledby`/`aria-describedby` to the title and
 * description explicitly so the association is provable by reading the DOM.
 * Carries `'use client'`: forwards `onOpenChange` and renders via controlled
 * `open` state.
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'full';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  size?: DialogSize;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Accessible label for the close button (from `@wp/i18n`). */
  closeLabel: string;
  /** Hides the close button (e.g. when the footer supplies its own exit action). */
  hideClose?: boolean;
}

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  full: 'max-w-[calc(100vw-2rem)]',
};

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  children,
  footer,
  closeLabel,
  hideClose = false,
}: DialogProps): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();

  return (
    <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)} modal>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop
          data-testid="dialog-backdrop"
          className={cx(
            'fixed inset-0 bg-overlay',
            'transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <BaseDialog.Popup
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className={cx(
            'fixed left-1/2 top-1/2 flex w-full -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
            'rounded-xl bg-surface p-6 font-ui text-fg shadow-lg',
            'transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
            'data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            SIZE_CLASSES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <BaseDialog.Title id={titleId} className="text-lg font-semibold">
              {title}
            </BaseDialog.Title>
            {hideClose ? null : (
              <BaseDialog.Close
                aria-label={closeLabel}
                className={cx(
                  'rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'focus-visible:ring-offset-2 ring-offset-bg',
                )}
              >
                <X aria-hidden="true" size={16} />
              </BaseDialog.Close>
            )}
          </div>
          {description ? (
            <BaseDialog.Description id={descriptionId} className="text-sm text-muted">
              {description}
            </BaseDialog.Description>
          ) : null}
          <div className="flex-1 overflow-y-auto">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2">{footer}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
