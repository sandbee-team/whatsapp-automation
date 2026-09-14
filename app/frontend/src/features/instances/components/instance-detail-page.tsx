import * as React from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ErrorState, Skeleton, Tabs, TabsPanel, useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { instanceKeys } from '../keys.js';
import { fetchInstanceCard, fetchHealthWhy, type HealthWhyResult } from '../api.js';
import { NeedsActionBanner } from './needs-action-banner.js';
import { ParkedBanner } from './parked-banner.js';
import { WhyDrawer } from './why-drawer.js';
import { InstanceDetailHeader } from './instance-detail-header.js';
import { InstanceDetailOverviewTab } from './instance-detail-overview-tab.js';
import { InstanceDetailHealthTab } from './instance-detail-health-tab.js';
import { InstanceDetailQueueTab } from './instance-detail-queue-tab.js';

/**
 * InstanceDetailPage (P26b U3) - the `/instances/$id` route's component:
 * `PageHeader` (breadcrumbs Numbers > label) delegated to
 * `InstanceDetailHeader` (status chips + pause/resume/reconnect/why
 * actions), `NeedsActionBanner`/`ParkedBanner` restyled as alerts (ids kept),
 * and Overview/Health/Queue tabs. Split into sibling files to respect the
 * workspace 300-line cap.
 */
export function InstanceDetailPage(): React.JSX.Element {
  const t = useT();
  const params = useParams({ strict: false });
  const id = params.id as string;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = React.useState('overview');
  const [whyDrawerOpen, setWhyDrawerOpen] = React.useState(false);
  const [whyData, setWhyData] = React.useState<HealthWhyResult | undefined>(undefined);

  const cardQuery = useQuery({
    queryKey: instanceKeys.card(id),
    queryFn: () => fetchInstanceCard(id),
  });

  const openWhyDrawer = (): void => {
    setWhyDrawerOpen(true);
    void fetchHealthWhy(id).then(setWhyData);
  };

  if (cardQuery.isLoading) {
    return (
      <div data-testid="instance-detail-loading" className="flex flex-col gap-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (cardQuery.isError || !cardQuery.data) {
    return (
      <ErrorState
        data-testid="instance-detail-error"
        title={t('instances.detail.error.title')}
        body={t('instances.detail.error.body')}
        retryAction={
          <Button variant="secondary" size="sm" onClick={() => cardQuery.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  const data = cardQuery.data;

  return (
    <div data-testid="instance-detail-screen" className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={[
          { label: t('instances.detail.breadcrumbLabel'), to: '/instances' },
          { label: data.label },
        ]}
        title={data.label}
        actions={
          <InstanceDetailHeader
            instanceId={id}
            data={data}
            onOpenWhyDrawer={openWhyDrawer}
            onMutated={() =>
              void queryClient.invalidateQueries({ queryKey: instanceKeys.card(id) })
            }
          />
        }
      />

      {data.parked ? <ParkedBanner /> : null}
      {data.needsUserAction && data.userActionReason ? (
        <NeedsActionBanner
          reason={data.userActionReason}
          instanceId={id}
          onOpenDetails={openWhyDrawer}
          onReconnect={() => void navigate({ to: '/instances' })}
        />
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: t('instances.detail.tabs.overview') },
          { value: 'health', label: t('instances.detail.tabs.health') },
          { value: 'queue', label: t('instances.detail.tabs.queue') },
        ]}
      >
        <TabsPanel value="overview">
          <InstanceDetailOverviewTab data={data} />
        </TabsPanel>
        <TabsPanel value="health">
          <InstanceDetailHealthTab instanceId={id} />
        </TabsPanel>
        <TabsPanel value="queue">
          <InstanceDetailQueueTab instanceId={id} />
        </TabsPanel>
      </Tabs>

      <WhyDrawer open={whyDrawerOpen} onOpenChange={setWhyDrawerOpen} data={whyData} />
    </div>
  );
}
