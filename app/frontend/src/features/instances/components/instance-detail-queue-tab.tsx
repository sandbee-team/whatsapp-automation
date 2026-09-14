import * as React from 'react';
import { KpiStat, SkeletonText, useT } from '@wp/ui';
import { useQueueStatus } from '../../wallet/api.js';

/**
 * InstanceDetailQueueTab (P26b U3) - this instance's own queue-status
 * counters, read from the SAME `GET /v1/queue-status` response
 * `useInstanceList` already joins per-instance (never a second endpoint).
 */
export function InstanceDetailQueueTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const t = useT();
  const { data, isLoading } = useQueueStatus();

  if (isLoading) {
    return <SkeletonText data-testid="instance-detail-queue-loading" lines={3} />;
  }

  const instance = data?.instances.find((item) => item.instanceId === instanceId);

  return (
    <div data-testid="instance-detail-queue-tab" className="grid gap-4 sm:grid-cols-3">
      <KpiStat label={t('instances.detail.queue.waiting')} value={String(instance?.waiting ?? 0)} />
      <KpiStat
        label={t('instances.detail.queue.sentToday')}
        value={String(instance?.sentToday ?? 0)}
      />
      <KpiStat
        label={t('instances.detail.queue.failedToday')}
        value={String(instance?.failedToday ?? 0)}
      />
    </div>
  );
}
