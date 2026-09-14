import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardBody, CardHeader, CardTitle, Button, Input, useT, useToast } from '@wp/ui';
import type { AdminImpersonationGrant } from '@wp/contracts';
import { uuidv7 } from '@wp/utils';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { grantImpersonation, revokeImpersonation } from '../../impersonation/api.js';
import { clientKeys } from '../keys.js';
import { ApiError } from '../../../lib/api-client.js';

/**
 * impersonation-card.tsx (P28 Unit U6, step 9) - "Open support session"
 * (reason + duration <= 30, result opens `panelUrl` via `window.open(...,
 * '_blank', 'noopener')` - never rendered as text) plus active grants with
 * Revoke. `canDo('impersonation.grant'/'impersonation.revoke')` greys out
 * controls the role may not use.
 */
export interface ImpersonationCardProps {
  clientId: string;
  activeGrants: AdminImpersonationGrant[];
}

export function ImpersonationCard({
  clientId,
  activeGrants,
}: ImpersonationCardProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [ttlMinutes, setTtlMinutes] = React.useState('30');

  const canGrant = canDo('impersonation.grant');
  const canRevoke = canDo('impersonation.revoke');
  const ttlValid = /^\d+$/.test(ttlMinutes) && Number(ttlMinutes) >= 1 && Number(ttlMinutes) <= 30;

  const onRevoke = async (grantId: string): Promise<void> => {
    try {
      await revokeImpersonation(grantId, 'revoked from client detail', uuidv7());
      showToast({ title: t('admin.common.successGeneric'), tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('admin.common.errorGeneric');
      showToast({ title: message, tone: 'danger' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.clientDetail.impersonation.title')}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <Button
          data-testid="client-detail-open-support-session"
          disabled={!canGrant}
          title={canGrant ? undefined : t('admin.roleTooltip.disabled')}
          onClick={() => setOpen(true)}
        >
          {t('admin.clientDetail.impersonation.openButton')}
        </Button>

        {activeGrants.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase text-muted">
              {t('admin.clientDetail.impersonation.activeGrants')}
            </span>
            {activeGrants.map((grant) => (
              <div
                key={grant.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>{grant.scope}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRevoke}
                  title={canRevoke ? undefined : t('admin.roleTooltip.disabled')}
                  onClick={() => void onRevoke(grant.id)}
                >
                  {t('admin.clientDetail.impersonation.revokeButton')}
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        <StaffActionDialog
          open={open}
          onOpenChange={setOpen}
          title={t('admin.clientDetail.impersonation.dialogTitle')}
          extraFieldsValid={ttlValid}
          successMessage={t('admin.common.successGeneric')}
          extraFields={
            <Input
              label={t('admin.clientDetail.impersonation.durationLabel')}
              data-testid="impersonation-ttl"
              inputMode="numeric"
              value={ttlMinutes}
              onChange={(event) => setTtlMinutes(event.target.value)}
            />
          }
          onSubmit={async (reason, idempotencyKey) => {
            const result = await grantImpersonation(
              clientId,
              { scope: 'metadata_only', ttlMinutes: Number(ttlMinutes) },
              reason,
              idempotencyKey,
            );
            // `panelUrl` is `null` only on a REPLAYED mint/elevate call (the
            // token is never re-emitted, C1 review round 2 MAJOR 2); this
            // dialog always sends a freshly generated `idempotencyKey`
            // (`uuidv7()` above), so a grant here is never itself a replay -
            // guarded anyway so a future caller reusing a key fails closed
            // (no window opened) instead of `window.open(null, ...)`.
            if (result.panelUrl) {
              window.open(result.panelUrl, '_blank', 'noopener');
            }
            await queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) });
          }}
        />
      </CardBody>
    </Card>
  );
}
