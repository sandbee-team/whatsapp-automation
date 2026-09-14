import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, ErrorState, SkeletonText, useT } from '@wp/ui';
import { instanceKeys } from '../keys.js';
import { fetchHealthWhy } from '../api.js';
import { WhyDrawerContent } from './why-drawer-content.js';

/**
 * InstanceDetailHealthTab (P26b U3) - the Health tab's own fetch of `GET
 * /v1/instances/:id/health/why`, rendered through the SAME
 * `WhyDrawerContent` the `WhyDrawer` sheet uses (never a second copy of the
 * honest-label logic).
 */
export function InstanceDetailHealthTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: instanceKeys.healthWhy(instanceId),
    queryFn: () => fetchHealthWhy(instanceId),
  });

  if (query.isLoading) {
    return <SkeletonText data-testid="instance-detail-health-loading" lines={5} />;
  }

  if (query.isError) {
    return (
      <ErrorState
        data-testid="instance-detail-health-error"
        title={t('instances.detail.error.title')}
        body={t('instances.detail.error.body')}
        retryAction={
          <Button variant="secondary" size="sm" onClick={() => query.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  return <WhyDrawerContent data={query.data} />;
}
