import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, Skeleton, Tabs, TabsPanel, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { getClient } from '../../features/clients/api.js';
import { clientKeys } from '../../features/clients/keys.js';
import { ClientHeaderActions } from '../../features/clients/components/client-header-actions.js';
import { OverviewTab } from '../../features/clients/components/overview-tab.js';
import { LimitsTab } from '../../features/clients/components/limits-tab.js';
import { PricingTab } from '../../features/clients/components/pricing-tab.js';
import { WalletTab } from '../../features/clients/components/wallet-tab.js';
import { InstancesTab } from '../../features/clients/components/instances-tab.js';
import { AuditTab } from '../../features/clients/components/audit-tab.js';

export const Route = createFileRoute('/_authed/clients/$clientId')({
  component: ClientDetailPage,
});

/**
 * clients.$clientId.tsx (P28 Unit U6, step 9) - the client-detail workbench:
 * header + tabs (Overview | Limits & plan | Pricing | Wallet | Instances |
 * Audit), design brief section 2 item 2. Each tab body lives in its own
 * component (300-line-cap idiom); this file is the orchestrator only.
 */
function ClientDetailPage(): React.JSX.Element {
  const t = useT();
  const { clientId } = Route.useParams();
  const [tab, setTab] = React.useState('overview');

  const query = useQuery({
    queryKey: clientKeys.detail(clientId),
    queryFn: () => getClient(clientId),
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <ErrorState
        title={t('admin.clients.error.title')}
        retryAction={
          <button
            type="button"
            data-testid="client-detail-retry"
            onClick={() => void query.refetch()}
            className="inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-sm font-ui text-fg hover:bg-surface-2"
          >
            {t('admin.common.retry')}
          </button>
        }
      />
    );
  }

  const client = query.data;

  return (
    <div>
      <PageHeader
        title={client.companyName}
        description={client.slug}
        actions={<ClientHeaderActions clientId={client.id} status={client.status} />}
      />

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: t('admin.clientDetail.tab.overview') },
          { value: 'limits', label: t('admin.clientDetail.tab.limits') },
          { value: 'pricing', label: t('admin.clientDetail.tab.pricing') },
          { value: 'wallet', label: t('admin.clientDetail.tab.wallet') },
          { value: 'instances', label: t('admin.clientDetail.tab.instances') },
          { value: 'audit', label: t('admin.clientDetail.tab.audit') },
        ]}
      >
        <TabsPanel value="overview">
          <OverviewTab client={client} />
        </TabsPanel>
        <TabsPanel value="limits">
          <LimitsTab client={client} />
        </TabsPanel>
        <TabsPanel value="pricing">
          <PricingTab client={client} />
        </TabsPanel>
        <TabsPanel value="wallet">
          <WalletTab client={client} />
        </TabsPanel>
        <TabsPanel value="instances">
          <InstancesTab client={client} />
        </TabsPanel>
        <TabsPanel value="audit">
          <AuditTab client={client} />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
