import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Input, Select, useT } from '@wp/ui';
import type { AdminClientDetail } from '../api.js';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { adjustWallet, creditWallet, freezeWallet, unfreezeWallet } from '../../wallet/api.js';
import { formatPaiseAsRupees } from '../../../lib/money.js';
import { clientKeys } from '../keys.js';

/**
 * wallet-tab.tsx (P28 Unit U6, step 9) - Credit / Adjust / Freeze / Unfreeze,
 * each `canDo`-gated (`wallet.credit`/`wallet.adjust`/`wallet.freeze`/
 * `wallet.unfreeze`). Amount inputs are integer-paise strings; never
 * `parseFloat`.
 */
export interface WalletTabProps {
  client: AdminClientDetail;
}

const CREDIT_KIND_OPTIONS = [
  { value: 'topup_manual', labelKey: 'admin.clientDetail.wallet.kindTopupManual' },
  { value: 'promo_credit', labelKey: 'admin.clientDetail.wallet.kindPromoCredit' },
] as const;

export function WalletTab({ client }: WalletTabProps): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const queryClient = useQueryClient();
  const [creditOpen, setCreditOpen] = React.useState(false);
  const [adjustOpen, setAdjustOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [kind, setKind] = React.useState<string | null>('topup_manual');

  const canCredit = canDo('wallet.credit');
  const canAdjust = canDo('wallet.adjust');
  const canFreeze = canDo('wallet.freeze');
  const canUnfreeze = canDo('wallet.unfreeze');
  const amountValid = /^-?\d+$/.test(amount);
  const creditAmountValid = /^\d+$/.test(amount);

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: clientKeys.detail(client.id) }).then(() => undefined);

  const onFreezeToggle = async (freeze: boolean): Promise<void> => {
    const idempotencyKey = crypto.randomUUID();
    if (freeze) await freezeWallet(client.id, 'freeze from client detail', idempotencyKey);
    else await unfreezeWallet(client.id, 'unfreeze from client detail', idempotencyKey);
    await refresh();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.clientDetail.tab.wallet')}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <div>
            <div className="text-xs text-muted">{t('admin.clientDetail.wallet.balance')}</div>
            <div className="text-lg font-semibold text-fg">
              {client.wallet ? formatPaiseAsRupees(client.wallet.balanceMinor) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">{t('admin.clientDetail.wallet.state')}</div>
            <Badge tone={client.wallet?.state === 'frozen' ? 'danger' : 'neutral'}>
              {client.wallet?.state ?? '—'}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid="client-detail-wallet-credit"
            disabled={!canCredit}
            title={canCredit ? undefined : t('admin.roleTooltip.disabled')}
            onClick={() => setCreditOpen(true)}
          >
            {t('admin.clientDetail.wallet.credit.button')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="client-detail-wallet-adjust"
            disabled={!canAdjust}
            title={canAdjust ? undefined : t('admin.roleTooltip.disabled')}
            onClick={() => setAdjustOpen(true)}
          >
            {t('admin.clientDetail.wallet.adjust.button')}
          </Button>
          {client.wallet?.state === 'frozen' ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="client-detail-wallet-unfreeze"
              disabled={!canUnfreeze}
              title={canUnfreeze ? undefined : t('admin.roleTooltip.disabled')}
              onClick={() => void onFreezeToggle(false)}
            >
              {t('admin.clientDetail.wallet.unfreeze.button')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              data-testid="client-detail-wallet-freeze"
              disabled={!canFreeze}
              title={canFreeze ? undefined : t('admin.roleTooltip.disabled')}
              onClick={() => void onFreezeToggle(true)}
            >
              {t('admin.clientDetail.wallet.freeze.button')}
            </Button>
          )}
        </div>
      </CardBody>

      <StaffActionDialog
        open={creditOpen}
        onOpenChange={setCreditOpen}
        title={t('admin.clientDetail.wallet.credit.title')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={creditAmountValid && kind !== null}
        extraFields={
          <div className="flex flex-col gap-3">
            <Input
              label={t('admin.clientDetail.wallet.amountLabel')}
              data-testid="client-detail-wallet-credit-amount"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Select
              label={t('admin.clientDetail.wallet.kindLabel')}
              placeholder={t('admin.clientDetail.wallet.kindLabel')}
              value={kind}
              onValueChange={(value) => setKind(value)}
              options={CREDIT_KIND_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            />
          </div>
        }
        onSubmit={async (reason, idempotencyKey) => {
          await creditWallet(
            client.id,
            amount,
            (kind ?? 'topup_manual') as never,
            reason,
            idempotencyKey,
          );
          await refresh();
        }}
      />

      <StaffActionDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        title={t('admin.clientDetail.wallet.adjust.title')}
        successMessage={t('admin.common.successGeneric')}
        extraFieldsValid={amountValid}
        extraFields={
          <Input
            label={t('admin.clientDetail.wallet.amountLabel')}
            data-testid="client-detail-wallet-adjust-amount"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        }
        onSubmit={async (reason, idempotencyKey) => {
          await adjustWallet(client.id, amount, reason, idempotencyKey);
          await refresh();
        }}
      />
    </Card>
  );
}
