import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, CardHeader, CardTitle, Input, useT } from '@wp/ui';
import { PRICE_KEYS } from '@wp/domain';
import type { AdminClientDetail } from '../api.js';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { setClientPricing } from '../api.js';
import { clientKeys } from '../keys.js';

/**
 * pricing-tab.tsx (P28 Unit U6, step 9) - the client-detail Pricing tab.
 * `overrideItems` is a PARTIAL record (`setClientPricingInputSchema`): an
 * empty amount input clears that key rather than sending `0`. Shows the
 * resulting `maxRateMinor` from the wallet header when present.
 */
export interface PricingTabProps {
  client: AdminClientDetail;
}

export function PricingTab({ client }: PricingTabProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const canEdit = canDo('clients.pricing');

  const overrideItems = client.pricing?.overrideItems ?? {};

  const buildOverrides = (): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const key of PRICE_KEYS) {
      const raw = amounts[key];
      if (raw !== undefined && raw.trim() !== '') {
        result[key] = Number(raw);
      }
    }
    return result;
  };

  const allAmountsValid = PRICE_KEYS.every((key) => {
    const raw = amounts[key];
    return raw === undefined || raw.trim() === '' || /^\d+$/.test(raw);
  });

  return (
    <Card>
      <CardHeader
        actions={
          <Button
            variant="outline"
            size="sm"
            data-testid="client-detail-edit-pricing"
            disabled={!canEdit}
            title={canEdit ? undefined : t('admin.roleTooltip.disabled')}
            onClick={() => setOpen(true)}
          >
            {t('admin.clientDetail.pricing.editButton')}
          </Button>
        }
      >
        <CardTitle>{t('admin.clientDetail.pricing.title')}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        {PRICE_KEYS.map((key) => (
          <div key={key} className="flex items-center justify-between text-sm">
            <span className="text-muted">{key}</span>
            <span className="text-fg">{String(overrideItems[key] ?? '—')}</span>
          </div>
        ))}
        {client.wallet ? (
          <p className="pt-2 text-xs text-muted">
            {t('admin.clientDetail.pricing.maxRate', { amount: client.wallet.maxRateMinor })}
          </p>
        ) : null}
      </CardBody>

      <StaffActionDialog
        open={open}
        onOpenChange={setOpen}
        title={t('admin.clientDetail.pricing.dialogTitle')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={allAmountsValid}
        extraFields={
          <div className="flex flex-col gap-3">
            {PRICE_KEYS.map((key) => (
              <Input
                key={key}
                label={key}
                data-testid={`client-detail-pricing-${key}`}
                value={amounts[key] ?? ''}
                onChange={(event) =>
                  setAmounts((current) => ({ ...current, [key]: event.target.value }))
                }
              />
            ))}
          </div>
        }
        onSubmit={async (reason, idempotencyKey) => {
          await setClientPricing(client.id, buildOverrides(), reason, idempotencyKey);
          await queryClient.invalidateQueries({ queryKey: clientKeys.detail(client.id) });
        }}
      />
    </Card>
  );
}
