import * as React from 'react';
import { Dialog, useT, useToast } from '@wp/ui';
import { uuidv7 } from '@wp/utils';
import { ApiError } from '../lib/api-client.js';
import { ReasonField, isReasonValid } from './reason-field.js';

/**
 * staff-action-dialog.tsx (P28 Unit U6, step 9) - the ONE mutation-dialog
 * shell every staff action reuses: title, optional context body, the
 * mandatory `ReasonField`, an `extraFields` slot for the action's own
 * inputs, and a primary button disabled until the reason is valid AND the
 * caller's own `extraFieldsValid` (default true) passes. Owns a SINGLE
 * `uuidv7()` idempotency key per open (regenerated only when the dialog is
 * reopened), reused verbatim across the automatic 401-refresh-retry inside
 * `adminMutate` - the caller's `onSubmit` receives `(reason, idempotencyKey)`
 * and is responsible for calling `adminMutate` with it. Success/failure
 * surface as toasts; the dialog stays open on failure so the staff member can
 * retry without re-typing the reason.
 */
export interface StaffActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  context?: string;
  destructive?: boolean;
  extraFields?: React.ReactNode;
  extraFieldsValid?: boolean;
  submitLabel?: string;
  successMessage: string;
  onSubmit: (reason: string, idempotencyKey: string) => Promise<void>;
}

export function StaffActionDialog({
  open,
  onOpenChange,
  title,
  context,
  destructive = false,
  extraFields,
  extraFieldsValid = true,
  submitLabel,
  successMessage,
  onSubmit,
}: StaffActionDialogProps): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const idempotencyKeyRef = React.useRef<string>(uuidv7());

  React.useEffect(() => {
    if (open) {
      idempotencyKeyRef.current = uuidv7();
      setReason('');
    }
  }, [open]);

  const reasonOk = isReasonValid(reason);
  const canSubmit = reasonOk && extraFieldsValid && !submitting;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(reason.trim(), idempotencyKeyRef.current);
      showToast({ title: successMessage, tone: 'success' });
      onOpenChange(false);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('admin.common.errorGeneric');
      showToast({ title: message, tone: 'danger' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={context}
      closeLabel={t('admin.common.close')}
      footer={
        <>
          <button
            type="button"
            data-testid="staff-action-cancel"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            className="inline-flex h-9 items-center justify-center rounded-md border border-border-strong px-4 text-sm font-medium font-ui text-fg hover:bg-surface-2 disabled:opacity-50"
          >
            {t('admin.common.cancel')}
          </button>
          <button
            type="button"
            data-testid="staff-action-submit"
            disabled={!canSubmit}
            aria-busy={submitting || undefined}
            onClick={() => void handleSubmit()}
            className={
              'inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium font-ui text-accent-fg disabled:opacity-50 disabled:pointer-events-none ' +
              (destructive ? 'bg-danger hover:bg-danger-hover' : 'bg-accent hover:bg-accent-hover')
            }
          >
            {submitLabel ?? t('admin.common.save')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {extraFields}
        <ReasonField value={reason} onChange={setReason} />
      </div>
    </Dialog>
  );
}
