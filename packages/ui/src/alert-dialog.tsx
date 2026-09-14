'use client';

import * as React from 'react';
import { AlertDialog as BaseAlertDialog } from '@base-ui/react/alert-dialog';
import { cx } from './lib/cx.js';
import { Button } from './button.js';

/**
 * AlertDialog - a confirm/cancel pattern on Base UI's AlertDialog (ADR 0007).
 * Always modal (Base UI's alert dialog cannot be dismissed by an outside
 * click - the caller must choose Cancel or Confirm), `role="alertdialog"` is
 * set by Base UI. Carries `'use client'`: forwards `onOpenChange`/`onConfirm`.
 */
export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  /** Uses the danger button variant for the confirm action. */
  destructive?: boolean;
  /** Disables both actions and shows a spinner on confirm. */
  loading?: boolean;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = false,
  loading = false,
}: AlertDialogProps): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();

  return (
    <BaseAlertDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BaseAlertDialog.Portal>
        <BaseAlertDialog.Backdrop
          className={cx(
            'fixed inset-0 bg-overlay',
            'transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <BaseAlertDialog.Popup
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={cx(
            'fixed left-1/2 top-1/2 flex w-full max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
            'rounded-xl bg-surface p-6 font-ui text-fg shadow-lg',
            'transition-[opacity,transform] duration-150 data-[starting-style]:scale-95',
            'data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
          )}
        >
          <BaseAlertDialog.Title id={titleId} className="text-lg font-semibold">
            {title}
          </BaseAlertDialog.Title>
          <BaseAlertDialog.Description id={descriptionId} className="text-sm text-muted">
            {body}
          </BaseAlertDialog.Description>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={loading}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              size="sm"
              disabled={loading}
              loading={loading}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </BaseAlertDialog.Popup>
      </BaseAlertDialog.Portal>
    </BaseAlertDialog.Root>
  );
}
