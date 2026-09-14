import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { KpiStat, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { getQueueSummary } from '../../features/queue/api.js';

export const Route = createFileRoute('/_authed/queue')({
  component: QueuePage,
});

const REFETCH_INTERVAL_MS = 15_000;

function QueuePage(): React.JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: ['admin', 'queue', 'summary'],
    queryFn: getQueueSummary,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const jobsByStatus = query.data?.jobsByStatus ?? {};
  const instancesByHealthState = query.data?.instancesByHealthState ?? {};

  return (
    <div>
      <PageHeader title={t('admin.queue.title')} description={t('admin.queue.description')} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(jobsByStatus).map(([status, count]) => (
          <KpiStat key={status} label={status} value={String(count)} loading={query.isLoading} />
        ))}
        {Object.entries(instancesByHealthState).map(([state, count]) => (
          <KpiStat key={state} label={state} value={String(count)} loading={query.isLoading} />
        ))}
        <KpiStat
          label={t('admin.queue.unownedInstances')}
          value={String(query.data?.unownedInstances ?? 0)}
          loading={query.isLoading}
        />
      </div>

      <p className="mt-6 text-xs text-muted" data-testid="queue-footnote">
        {t('admin.queue.footnote')}
      </p>
    </div>
  );
}
