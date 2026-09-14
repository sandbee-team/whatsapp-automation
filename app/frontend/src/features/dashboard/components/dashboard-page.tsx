import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button, ErrorState, Reveal } from '@wp/ui';
import { useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { WalletBanner, useQueueStatus } from '../../wallet/index.js';
import { useWalletSummary } from '../../wallet/api.js';
import { useInstanceList } from '../../instances/use-instance-list.js';
import { useDashboardSummary } from '../api.js';
import { deriveHasSentMessage, deriveHasWalletFunds } from '../dashboard-derive.js';
import { DashboardKpiRow } from './dashboard-kpi-row.js';
import { GettingStartedChecklist } from './getting-started-checklist.js';
import { DashboardNumbersCard } from './dashboard-numbers-card.js';
import { DashboardOutcomesCard } from './dashboard-outcomes-card.js';
import { DashboardFleetHealthCard } from './dashboard-fleet-health-card.js';
import { DashboardWalletCard } from './dashboard-wallet-card.js';
import { RecentActivityCard } from './recent-activity-card.js';

export { deriveHasSentMessage, deriveHasWalletFunds };

/**
 * DashboardPage (P26b U3; 2026-09-08 panel refresh, unit S2 - full restyle
 * per spec section 5) - one `PageHeader` (action = "Connect a number" while
 * zero numbers, otherwise "Send a message" + secondary "Connect a number"),
 * a KPI row inside `Stagger`, the getting-started hero until a number is
 * linked, a two-column "Sending today" / "Today's outcomes" row, then a
 * three-column "Fleet health" / "Wallet" / "Recent activity" row.
 * `dashboard.summary.error` covers the one query (`useDashboardSummary`)
 * whose failure should stop the whole page reading as healthy - every other
 * section owns its own error/retry so one failing query never blanks the
 * rest of the page. Pure derivations live in `dashboard-derive.ts`.
 */
export function DashboardPage(): React.JSX.Element {
  const t = useT();
  const summaryQuery = useDashboardSummary();
  const queueStatusQuery = useQueueStatus();
  const walletQuery = useWalletSummary();
  const { items, isLoading: isInstancesLoading } = useInstanceList();

  const hasLinkedInstance = items.some((item) => item.card?.linkState === 'linked');
  const hasSentMessage = deriveHasSentMessage(queueStatusQuery.data?.workspace.sentToday);
  const hasWalletFunds = deriveHasWalletFunds(walletQuery.data);
  const needsActionCount = items.filter((item) => item.card?.needsUserAction).length;

  const isLoading = summaryQuery.isLoading || queueStatusQuery.isLoading;
  const showConnectAction = !isInstancesLoading && items.length === 0;

  return (
    <div data-testid="dashboard-screen" className="flex flex-col gap-6">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={
          showConnectAction ? (
            <Link to="/instances">
              <Button data-testid="dashboard-connect-cta">{t('dashboard.empty.cta')}</Button>
            </Link>
          ) : (
            <>
              <Link to="/messages">
                <Button data-testid="dashboard-send-message-cta">
                  {t('messages.compose.title')}
                </Button>
              </Link>
              <Link to="/instances">
                <Button variant="secondary" data-testid="dashboard-connect-secondary-cta">
                  {t('dashboard.empty.cta')}
                </Button>
              </Link>
            </>
          )
        }
      />

      {summaryQuery.isError ? (
        <ErrorState
          data-testid="dashboard-summary-error"
          title={t('dashboard.summary.error')}
          body={t('common.error.generic')}
          retryAction={
            <Button variant="secondary" size="sm" onClick={() => summaryQuery.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <DashboardKpiRow
          summary={summaryQuery.data}
          queueStatus={queueStatusQuery.data}
          isLoading={isLoading}
          needsActionCount={needsActionCount}
          walletBalanceMinor={walletQuery.data?.balanceMinor}
        />
      )}

      <WalletBanner />

      {!isInstancesLoading && !hasLinkedInstance ? (
        <Reveal variant="rise">
          <GettingStartedChecklist
            hasLinkedInstance={hasLinkedInstance}
            hasSentMessage={hasSentMessage}
            hasWalletFunds={hasWalletFunds}
          />
        </Reveal>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <DashboardNumbersCard />
        <DashboardOutcomesCard workspace={queueStatusQuery.data?.workspace} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <DashboardFleetHealthCard items={items} />
        <DashboardWalletCard wallet={walletQuery.data} isLoading={walletQuery.isLoading} />
        <RecentActivityCard />
      </div>
    </div>
  );
}
