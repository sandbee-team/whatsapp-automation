import * as React from 'react';
import { Badge, Card, CardBody, useT } from '@wp/ui';
import type { AdminClientDetail } from '../api.js';
import { formatPaiseAsRupees } from '../../../lib/money.js';
import { ImpersonationCard } from './impersonation-card.js';

/**
 * overview-tab.tsx (P28 Unit U6, step 9) - the client-detail Overview tab:
 * a summary card plus the impersonation card (support session controls).
 */
export interface OverviewTabProps {
  client: AdminClientDetail;
}

export function OverviewTab({ client }: OverviewTabProps): React.JSX.Element {
  const t = useT();
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-muted">{t('admin.clients.table.status')}</div>
            <Badge tone={client.status === 'active' ? 'success' : 'danger'}>{client.status}</Badge>
          </div>
          <div>
            <div className="text-xs text-muted">{t('admin.clients.table.plan')}</div>
            <div className="text-sm text-fg">{client.planName ?? '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted">{t('admin.clientDetail.wallet.balance')}</div>
            <div className="text-sm text-fg">
              {client.wallet ? formatPaiseAsRupees(client.wallet.balanceMinor) : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">{t('admin.clients.table.onboarding')}</div>
            <div className="text-sm text-fg">{client.onboardingStep}</div>
          </div>
        </CardBody>
      </Card>

      <ImpersonationCard clientId={client.id} activeGrants={client.activeImpersonations} />
    </div>
  );
}
