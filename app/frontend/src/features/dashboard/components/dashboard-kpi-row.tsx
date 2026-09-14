import * as React from 'react';
import { MessagesSquare, Phone, Send, Wallet } from 'lucide-react';
import { Card, KpiStat, Stagger, useT } from '@wp/ui';
import { paiseToRupees } from '../../wallet/money.js';
import { deriveKpiHints } from '../dashboard-derive.js';
import type { DashboardSummary } from '../api.js';
import type { QueueStatus } from '../../wallet/api.js';

/**
 * DashboardKpiRow (P26b U3; 2026-09-08 panel refresh restyle) - the
 * four-tile KPI row: `connectedNumbers`, `queued`, `sent` (all from `GET
 * /v1/dashboard/summary`) plus `failedToday`/`spentTodayMinor` read from the
 * workspace's `queue-status` (kept as ONE extra "spent today" tile so the
 * row still totals four, per spec). Each tile now carries a tone, a
 * `numericValue` for the accent/info/success tiles (count-up via
 * `AnimatedNumber`; the currency tile keeps its formatted string, per spec)
 * and an honest hint line from `deriveKpiHints` - never fabricated while its
 * query is still pending. Loading renders `KpiStat`'s own `loading`
 * skeleton (no layout shift). Each `KpiStat` sits inside its own `Card` (spec
 * section 5 item 2: KPI CARDS, not bare tiles) - `Stagger` renders the grid
 * container directly (`data-testid="dashboard-kpi-row"`) and wraps each
 * `Card` in its own `Reveal`, so the grid layout is never split across four
 * one-item grids (defect fix 2026-09-08).
 */
export interface DashboardKpiRowProps {
  summary: DashboardSummary | undefined;
  queueStatus: QueueStatus | undefined;
  isLoading: boolean;
  /** Count of listed instances whose card marks `needsUserAction`. */
  needsActionCount: number;
  /** The wallet's own `balanceMinor`, formatted into the "Spent today" hint (spec: "balance {balance} from wallet summary"). */
  walletBalanceMinor: number | undefined;
}

export function DashboardKpiRow({
  summary,
  queueStatus,
  isLoading,
  needsActionCount,
  walletBalanceMinor,
}: DashboardKpiRowProps): React.JSX.Element {
  const t = useT();
  const spentTodayMinor = queueStatus ? Number(queueStatus.workspace.spentTodayMinor) : 0;
  const hints = deriveKpiHints({
    connectedNumbers: summary?.connectedNumbers ?? 0,
    needsActionCount,
    queuedAcrossCount: queueStatus?.instances.length ?? 0,
    failedToday: queueStatus?.workspace.failedToday ?? 0,
  });

  return (
    <Stagger
      variant="rise"
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      data-testid="dashboard-kpi-row"
    >
      <Card padding="md" className="h-full" data-testid="kpi-card-connected-numbers">
        <KpiStat
          data-testid="stat-connected-numbers"
          label={t('dashboard.connectedNumbers')}
          value={String(summary?.connectedNumbers ?? 0)}
          numericValue={summary?.connectedNumbers}
          icon={<Phone aria-hidden="true" size={16} />}
          tone="accent"
          hint={t(
            `dashboard.kpi.connectedNumbers.${hints.connectedNumbersHintKey}` as never,
            hints.connectedNumbersHintVars,
          )}
          loading={isLoading}
        />
      </Card>
      <Card padding="md" className="h-full" data-testid="kpi-card-queued">
        <KpiStat
          data-testid="stat-queued"
          label={t('dashboard.queued')}
          value={String(summary?.queued ?? 0)}
          numericValue={summary?.queued}
          icon={<MessagesSquare aria-hidden="true" size={16} />}
          tone="info"
          hint={t('dashboard.kpi.queued.acrossNumbers', hints.queuedHintVars)}
          loading={isLoading}
        />
      </Card>
      <Card padding="md" className="h-full" data-testid="kpi-card-sent">
        <KpiStat
          data-testid="stat-sent"
          label={t('dashboard.sent')}
          value={String(summary?.sent ?? 0)}
          numericValue={summary?.sent}
          icon={<Send aria-hidden="true" size={16} />}
          tone="success"
          hint={t('dashboard.kpi.sent.failedToday', hints.sentHintVars)}
          loading={isLoading}
        />
      </Card>
      <Card padding="md" className="h-full" data-testid="kpi-card-spent-today">
        <KpiStat
          data-testid="stat-spent-today"
          label={t('dashboard.spentToday')}
          value={paiseToRupees(spentTodayMinor)}
          icon={<Wallet aria-hidden="true" size={16} />}
          tone="warning"
          hint={t('dashboard.kpi.spentToday.balance', {
            balance: walletBalanceMinor === undefined ? '—' : paiseToRupees(walletBalanceMinor),
          })}
          loading={isLoading}
        />
      </Card>
    </Stagger>
  );
}
