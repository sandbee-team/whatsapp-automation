import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Textarea,
  useT,
} from '@wp/ui';
import type { AdminClientDetail } from '../api.js';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { setClientLimits } from '../api.js';
import { clientKeys } from '../keys.js';

/**
 * limits-tab.tsx (P28 Unit U6, step 9) - the client-detail "Limits & plan"
 * tab: plan values and overrides shown SEPARATELY (never pre-merged, per the
 * contract's own doc comment), and an edit dialog that submits a raw JSON
 * overrides array (kept simple - a full per-key form is future work).
 */
export interface LimitsTabProps {
  client: AdminClientDetail;
}

export function LimitsTab({ client }: LimitsTabProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [overridesJson, setOverridesJson] = React.useState('[]');
  const canEdit = canDo('clients.limits');

  const parsed = React.useMemo(() => {
    try {
      const value: unknown = JSON.parse(overridesJson);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }, [overridesJson]);

  return (
    <Card>
      <CardHeader
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="client-detail-edit-limits"
            disabled={!canEdit}
            title={canEdit ? undefined : t('admin.roleTooltip.disabled')}
            onClick={() => setOpen(true)}
          >
            {t('admin.clientDetail.limits.editButton')}
          </Button>
        }
      >
        <CardTitle>{t('admin.clientDetail.limits.title')}</CardTitle>
      </CardHeader>
      <CardBody>
        <Table caption={t('admin.clientDetail.limits.title')}>
          <THead>
            <TR>
              <TH>{t('admin.clientDetail.limits.override')}</TH>
              <TH>{t('admin.clientDetail.limits.planValue')}</TH>
              <TH>{t('admin.clientDetail.limits.expiry')}</TH>
            </TR>
          </THead>
          <TBody>
            {client.limits.overrides.map((override) => (
              <TR key={override.limitKey}>
                <TD>{override.limitKey}</TD>
                <TD>{override.limitValue ?? '—'}</TD>
                <TD>{override.expiresAt ?? '—'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </CardBody>

      <StaffActionDialog
        open={open}
        onOpenChange={setOpen}
        title={t('admin.clientDetail.limits.dialogTitle')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={parsed !== null}
        extraFields={
          <Textarea
            label={t('admin.clientDetail.limits.dialogTitle')}
            data-testid="client-detail-limits-json"
            value={overridesJson}
            onChange={(event) => setOverridesJson(event.target.value)}
          />
        }
        onSubmit={async (reason, idempotencyKey) => {
          if (!parsed) return;
          await setClientLimits(client.id, { overrides: parsed as never }, reason, idempotencyKey);
          await queryClient.invalidateQueries({ queryKey: clientKeys.detail(client.id) });
        }}
      />
    </Card>
  );
}
