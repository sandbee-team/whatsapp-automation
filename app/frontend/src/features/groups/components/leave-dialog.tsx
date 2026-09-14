import * as React from 'react';
import { Button, Card, CardBody, CardFooter, useT } from '@wp/ui';

/**
 * LeaveDialog (P24 groups-messaging, Unit U5) - the confirm surface for a
 * group row's "Leave" action. Leaving is always allowed and idempotent
 * (`requestGroupLeaveResponseSchema`'s own doc comment) so this dialog never
 * needs an error state beyond the generic one the caller may show.
 */
export interface LeaveDialogProps {
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LeaveDialog({ busy, onConfirm, onCancel }: LeaveDialogProps): React.JSX.Element {
  const t = useT();

  return (
    <Card role="dialog" aria-modal="true" data-testid="leave-dialog">
      <CardBody>
        <h3 className="text-lg font-semibold font-ui text-fg">{t('groups.leave.title')}</h3>
        <p>{t('groups.leave.body')}</p>
      </CardBody>
      <CardFooter>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          {t('groups.enable.cancel')}
        </Button>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={busy}>
          {t('groups.leave.confirm')}
        </Button>
      </CardFooter>
    </Card>
  );
}
