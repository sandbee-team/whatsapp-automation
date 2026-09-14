import * as React from 'react';
import { Badge, Table, THead, TBody, TR, TH, TD, useT } from '@wp/ui';
import type { AdminClientDetail } from '../api.js';
import { InstanceRowActions } from './instance-row-actions.js';

/**
 * instances-tab.tsx (P28 Unit U6, step 9) - client-detail Instances tab:
 * health/link/desired/pause reason/band/tier/lease owner/queue depth/oldest
 * queued age, plus per-row actions.
 */
export interface InstancesTabProps {
  client: AdminClientDetail;
}

export function InstancesTab({ client }: InstancesTabProps): React.JSX.Element {
  const t = useT();

  return (
    <Table caption={t('admin.clientDetail.tab.instances')}>
      <THead>
        <TR>
          <TH>{t('admin.clientDetail.instances.health')}</TH>
          <TH>{t('admin.clientDetail.instances.link')}</TH>
          <TH>{t('admin.clientDetail.instances.desired')}</TH>
          <TH>{t('admin.clientDetail.instances.pauseReason')}</TH>
          <TH>{t('admin.clientDetail.instances.band')}</TH>
          <TH>{t('admin.clientDetail.instances.tier')}</TH>
          <TH>{t('admin.clientDetail.instances.leaseOwner')}</TH>
          <TH>{t('admin.clientDetail.instances.queueDepth')}</TH>
          <TH>{t('admin.clientDetail.instances.oldestQueued')}</TH>
          <TH>{t('admin.common.save')}</TH>
        </TR>
      </THead>
      <TBody>
        {client.instances.map((instance) => (
          <TR key={instance.id}>
            <TD>
              <Badge tone="neutral">{instance.healthState}</Badge>
            </TD>
            <TD>{instance.linkState ?? '—'}</TD>
            <TD>{instance.desiredState}</TD>
            <TD>{instance.pauseReason ?? '—'}</TD>
            <TD>{instance.band ?? '—'}</TD>
            <TD>{instance.tier ?? '—'}</TD>
            <TD>{instance.ownerWorkerId ?? '—'}</TD>
            <TD>{instance.queueDepth}</TD>
            <TD>{instance.oldestQueuedAgeSeconds ?? '—'}</TD>
            <TD>
              <InstanceRowActions clientId={client.id} instance={instance} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
