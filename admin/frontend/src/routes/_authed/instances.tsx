import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Radio } from 'lucide-react';
import { Badge, DataTable, EmptyState, Input, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { listInstances, type AdminInstanceItem } from '../../features/instances/api.js';
import { instanceKeys } from '../../features/instances/keys.js';

export const Route = createFileRoute('/_authed/instances')({
  component: InstancesListPage,
});

function InstancesListPage(): React.JSX.Element {
  const t = useT();
  const [healthState, setHealthState] = React.useState('');
  const [clientId, setClientId] = React.useState('');

  const query = useQuery({
    queryKey: instanceKeys.list({
      healthState: healthState || undefined,
      clientId: clientId || undefined,
    }),
    queryFn: () =>
      listInstances({ healthState: healthState || undefined, clientId: clientId || undefined }),
  });

  const columns: ColumnDef<AdminInstanceItem, unknown>[] = [
    {
      id: 'health',
      header: t('admin.clientDetail.instances.health'),
      cell: ({ row }) => <Badge tone="neutral">{row.original.healthState}</Badge>,
    },
    { accessorKey: 'linkState', header: t('admin.clientDetail.instances.link') },
    { accessorKey: 'desiredState', header: t('admin.clientDetail.instances.desired') },
    { accessorKey: 'band', header: t('admin.clientDetail.instances.band') },
    { accessorKey: 'queueDepth', header: t('admin.clientDetail.instances.queueDepth') },
    { accessorKey: 'clientId', header: t('admin.instances.filter.client') },
  ];

  return (
    <div>
      <PageHeader
        title={t('admin.instances.title')}
        description={t('admin.instances.description')}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input
          label={t('admin.instances.filter.health')}
          data-testid="instances-filter-health"
          value={healthState}
          onChange={(event) => setHealthState(event.target.value)}
        />
        <Input
          label={t('admin.instances.filter.client')}
          data-testid="instances-filter-client"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
        />
      </div>

      <DataTable
        caption={t('admin.instances.table.caption')}
        columns={columns}
        data={query.data?.items ?? []}
        isLoading={query.isLoading}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            icon={<Radio aria-hidden size={24} />}
            title={t('admin.instances.empty.title')}
          />
        }
      />
    </div>
  );
}
