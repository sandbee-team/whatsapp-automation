import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2 } from 'lucide-react';
import { Badge, DataTable, EmptyState, ErrorState, Input, Select, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { listClients, type AdminClientListItem } from '../../features/clients/api.js';
import { clientKeys } from '../../features/clients/keys.js';
import { formatPaiseAsRupees } from '../../lib/money.js';

export const Route = createFileRoute('/_authed/clients')({
  component: ClientsListPage,
});

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  suspended: 'danger',
  onboarding: 'warning',
};

function ClientsListPage(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');

  const query = useQuery({
    queryKey: clientKeys.list({ status: status || undefined, q: search || undefined }),
    queryFn: () => listClients({ status: status || undefined, q: search || undefined }),
  });

  const columns: ColumnDef<AdminClientListItem, unknown>[] = [
    {
      accessorKey: 'companyName',
      header: t('admin.clients.table.company'),
      cell: ({ row }) => <span className="font-medium text-fg">{row.original.companyName}</span>,
    },
    { accessorKey: 'slug', header: t('admin.clients.table.slug') },
    {
      id: 'status',
      header: t('admin.clients.table.status'),
      cell: ({ row }) => (
        <Badge tone={STATUS_TONE[row.original.status] ?? 'neutral'}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'plan',
      header: t('admin.clients.table.plan'),
      cell: ({ row }) => row.original.planKey ?? '—',
    },
    { accessorKey: 'onboardingStep', header: t('admin.clients.table.onboarding') },
    {
      id: 'instances',
      header: t('admin.clients.table.instances'),
      cell: ({ row }) =>
        `${String(row.original.connectedCount)}/${String(row.original.instanceCount)}`,
    },
    {
      id: 'wallet',
      header: t('admin.clients.table.wallet'),
      cell: ({ row }) => {
        const item = row.original;
        if (!item.walletState || item.balanceMinor === null) return '—';
        return `${item.walletState} · ${formatPaiseAsRupees(item.balanceMinor)}`;
      },
    },
    {
      id: 'createdAt',
      header: t('admin.clients.table.created'),
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleDateString(),
    },
  ];

  return (
    <div>
      <PageHeader title={t('admin.clients.title')} description={t('admin.clients.description')} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input
          label={t('admin.clients.filter.search')}
          data-testid="clients-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          label={t('admin.clients.filter.status')}
          placeholder={t('admin.clients.filter.status')}
          value={status || null}
          onValueChange={(value) => setStatus(value)}
          options={[
            { value: 'active', label: 'active' },
            { value: 'suspended', label: 'suspended' },
            { value: 'onboarding', label: 'onboarding' },
          ]}
        />
      </div>

      <DataTable
        caption={t('admin.clients.table.caption')}
        columns={columns}
        data={query.data?.items ?? []}
        isLoading={query.isLoading}
        getRowId={(row) => row.id}
        onRowClick={(row) => void navigate({ to: `/clients/${row.id}` as never })}
        errorState={
          query.isError ? (
            <ErrorState
              title={t('admin.clients.error.title')}
              retryAction={
                <button
                  type="button"
                  data-testid="clients-retry"
                  onClick={() => void query.refetch()}
                  className="inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-sm font-ui text-fg hover:bg-surface-2"
                >
                  {t('admin.common.retry')}
                </button>
              }
            />
          ) : undefined
        }
        emptyState={
          <EmptyState
            icon={<Building2 aria-hidden size={24} />}
            title={t('admin.clients.empty.title')}
            body={t('admin.clients.empty.body')}
          />
        }
      />
    </div>
  );
}
