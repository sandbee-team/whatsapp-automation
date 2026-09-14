import * as React from 'react';
import { Alert, Badge, Card, CardBody, KpiStat, ToastProvider, useToast, useT } from '@wp/ui';
import type { BadgeTone } from '@wp/ui';
import { Wallet as WalletIcon } from 'lucide-react';
import { PageHeader } from '../../../components/page-header.js';
import { useWalletSummary, useQueueStatus, type WalletSummary } from '../api.js';
import { paiseToRupees } from '../money.js';
import { TopupRequestForm } from './topup-request-form.js';
import { WalletTopupHistory } from './wallet-topup-history.js';

/**
 * WalletScreen (P26b U5, new `/wallet` route) - KPI tiles (balance, state
 * badge, estimated messages remaining, spent today from `GET
 * /v1/queue-status`'s workspace total), the top-up request form, a
 * zero-balance honesty notice, and the top-up request history table. No
 * `ToastProvider` is mounted anywhere in the route tree yet (U2's shell
 * contract does not own it and this unit's scope excludes `components/**`),
 * so this screen mounts its own - nested providers are harmless (the
 * innermost one serves `useToast()`), and every mutation on this screen gets
 * a success/failure toast per the design brief without depending on a shell
 * change outside this unit's file scope.
 */
const STATE_TONE: Record<WalletSummary['state'], BadgeTone> = {
  active: 'success',
  low: 'warning',
  empty: 'danger',
  frozen: 'neutral',
};

function WalletScreenBody(): React.JSX.Element {
  const t = useT();
  const { showToast } = useToast();
  const { data: summary, isLoading: summaryLoading } = useWalletSummary();
  const { data: queueStatus, isLoading: queueLoading } = useQueueStatus();

  const stateLabel = summary ? t(`wallet.state.${summary.state}` as never) : '';

  return (
    <div data-testid="wallet-screen" className="flex flex-col gap-6">
      <PageHeader title={t('wallet.title')} description={t('wallet.subtitle')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardBody>
            <KpiStat
              label={t('wallet.kpi.balance')}
              value={summary ? paiseToRupees(summary.balanceMinor) : '—'}
              loading={summaryLoading}
              icon={<WalletIcon aria-hidden size={16} />}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-ui text-muted">{t('wallet.kpi.state')}</span>
              {summaryLoading || !summary ? (
                <span className="text-2xl font-semibold text-fg">—</span>
              ) : (
                <Badge data-testid="wallet-state-badge" tone={STATE_TONE[summary.state]}>
                  {stateLabel}
                </Badge>
              )}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <KpiStat
              label={t('wallet.kpi.estimatedRemaining')}
              value={summary ? String(summary.estimatedMessagesRemaining) : '—'}
              loading={summaryLoading}
            />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <KpiStat
              label={t('wallet.kpi.spentToday')}
              value={
                queueStatus ? paiseToRupees(Number(queueStatus.workspace.spentTodayMinor)) : '—'
              }
              loading={queueLoading}
            />
          </CardBody>
        </Card>
      </div>

      <Alert
        tone="neutral"
        title={t('wallet.zeroBalance.title')}
        body={t('wallet.zeroBalance.body')}
      />

      <Card>
        <CardBody>
          <TopupRequestForm
            onSubmitted={() => {
              showToast({ title: t('wallet.topup.submitButton'), tone: 'success' });
            }}
          />
        </CardBody>
      </Card>

      <WalletTopupHistory />
    </div>
  );
}

export function WalletScreen(): React.JSX.Element {
  return (
    <ToastProvider dismissLabel={undefined}>
      <WalletScreenBody />
    </ToastProvider>
  );
}
