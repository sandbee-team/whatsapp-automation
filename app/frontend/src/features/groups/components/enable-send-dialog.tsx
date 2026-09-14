import * as React from 'react';
import { Alert, Button, Card, CardBody, CardFooter, useT } from '@wp/ui';
import { DeviceBudgetLine } from './device-budget-line.js';

/**
 * EnableSendDialog (P24 groups-messaging, Unit U5) - the confirm surface
 * opened when a group row's send toggle is switched ON. Renders the FULL
 * `groups.disclosure` text again inside the dialog (the phase requires it
 * here, in addition to the screen header - core invariant 6: a risk
 * disclosure is never hidden behind a single reveal). Same inline
 * `role="dialog"` idiom as `broadcasts/components/confirm-action.tsx`
 * rather than a portal - keeps this dialog debuggable by the same
 * `screen.getByRole('dialog')` query used elsewhere in this app.
 *
 * On a 422 refusal the caller passes `errorMessage` and the dialog stays
 * OPEN (never silently closes on failure - core invariant: no silently
 * swallowed error).
 */
export interface EnableSendDialogProps {
  participantCount: number | null;
  budgetTotal: number;
  budgetMax: number;
  busy: boolean;
  errorMessage?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EnableSendDialog({
  participantCount,
  budgetTotal,
  budgetMax,
  busy,
  errorMessage,
  onConfirm,
  onCancel,
}: EnableSendDialogProps): React.JSX.Element {
  const t = useT();

  return (
    <Card role="dialog" aria-modal="true" data-testid="enable-send-dialog">
      <CardBody className="flex flex-col gap-3">
        <h3 className="text-lg font-semibold font-ui text-fg">{t('groups.enable.title')}</h3>
        <Alert
          tone="neutral"
          title={t('groups.disclosure')}
          data-testid="group-header-disclosure"
        />
        <p data-testid="enable-reach-line">
          {t('groups.enable.reach', { count: participantCount ?? 0 })}
        </p>
        <DeviceBudgetLine total={budgetTotal} max={budgetMax} />
        {errorMessage ? <Alert tone="danger" title={errorMessage} /> : null}
      </CardBody>
      <CardFooter>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {t('groups.enable.cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={busy}>
          {t('groups.enable.confirm')}
        </Button>
      </CardFooter>
    </Card>
  );
}
