import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, useT } from '@wp/ui';
import type { BadgeTone } from '@wp/ui';
import { paiseToRupees } from '../../wallet/money.js';
import type { WalletSummary } from '../../wallet/api.js';

/**
 * DashboardWalletCard (2026-09-08 panel refresh, unit S2) - balance, a state
 * `Badge` (reusing `wallet.state.*` copy from `en-data-ui.ts`, the same key
 * `wallet-screen.tsx` uses), and an honest estimate line built from
 * `estimatedMessagesRemaining` - explicitly framed as an estimate, never a
 * promise (spec section 5, core invariant 6). CTA links to `/wallet`.
 */
const STATE_TONE: Record<WalletSummary['state'], BadgeTone> = {
  active: 'success',
  low: 'warning',
  empty: 'danger',
  frozen: 'neutral',
};

export interface DashboardWalletCardProps {
  wallet: WalletSummary | undefined;
  isLoading: boolean;
}

export function DashboardWalletCard({
  wallet,
  isLoading,
}: DashboardWalletCardProps): React.JSX.Element {
  const t = useT();

  return (
    <Card data-testid="dashboard-wallet-card">
      <CardHeader>
        <CardTitle>{t('dashboard.wallet.cardTitle')}</CardTitle>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums text-fg">
              {isLoading || !wallet ? '—' : paiseToRupees(wallet.balanceMinor)}
            </span>
            {wallet ? (
              <Badge data-testid="dashboard-wallet-state-badge" tone={STATE_TONE[wallet.state]}>
                {t(`wallet.state.${wallet.state}` as never)}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted">
            {wallet
              ? t('dashboard.wallet.estimate', { count: wallet.estimatedMessagesRemaining })
              : null}
          </p>
          <Link to="/wallet">
            <Button variant="secondary" size="sm" data-testid="dashboard-wallet-add-funds">
              {t('dashboard.wallet.addFunds')}
            </Button>
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}
