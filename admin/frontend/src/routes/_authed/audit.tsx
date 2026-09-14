import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ScrollText } from 'lucide-react';
import { DataTable, EmptyState, Input, Sheet, useT } from '@wp/ui';
import { PageHeader } from '../../components/page-header.js';
import { listAudit, type AdminStaffAuditItem } from '../../features/audit/api.js';
import { auditKeys } from '../../features/audit/keys.js';

export const Route = createFileRoute('/_authed/audit')({
  component: AuditLogPage,
});

/**
 * audit.tsx (P28 Unit U6, step 9) - the staff audit log viewer: keyset
 * table (time, staff, action, client, target, reason) plus a `Sheet` drawer
 * with the full entry. `adminStaffAuditItemSchema` carries no separate
 * `result` field (contract as-shipped), so the drawer shows the full row -
 * a documented deviation from the dispatch's "stored result JSON" detail.
 */
function AuditLogPage(): React.JSX.Element {
  const t = useT();
  const [clientId, setClientId] = React.useState('');
  const [staffId, setStaffId] = React.useState('');
  const [selected, setSelected] = React.useState<AdminStaffAuditItem | null>(null);

  const query = useQuery({
    queryKey: auditKeys.list({ clientId: clientId || undefined, staffId: staffId || undefined }),
    queryFn: () => listAudit({ clientId: clientId || undefined, staffId: staffId || undefined }),
  });

  const columns: ColumnDef<AdminStaffAuditItem, unknown>[] = [
    {
      id: 'createdAt',
      header: t('admin.audit.table.time'),
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
    },
    { accessorKey: 'staffId', header: t('admin.audit.table.staff') },
    { accessorKey: 'action', header: t('admin.audit.table.action') },
    { accessorKey: 'clientId', header: t('admin.audit.table.client') },
    { accessorKey: 'targetRef', header: t('admin.audit.table.target') },
  ];

  return (
    <div>
      <PageHeader title={t('admin.audit.title')} description={t('admin.audit.description')} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Input
          label={t('admin.audit.filter.client')}
          data-testid="audit-filter-client"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
        />
        <Input
          label={t('admin.audit.filter.staff')}
          data-testid="audit-filter-staff"
          value={staffId}
          onChange={(event) => setStaffId(event.target.value)}
        />
      </div>

      <DataTable
        caption={t('admin.audit.table.caption')}
        columns={columns}
        data={query.data?.items ?? []}
        isLoading={query.isLoading}
        getRowId={(row) => row.id}
        onRowClick={(row) => setSelected(row)}
        emptyState={
          <EmptyState
            icon={<ScrollText aria-hidden size={24} />}
            title={t('admin.audit.empty.title')}
          />
        }
      />

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={t('admin.audit.detail.title')}
        closeLabel={t('admin.common.close')}
      >
        {selected ? (
          <pre
            data-testid="audit-detail-result"
            className="whitespace-pre-wrap break-words rounded-md bg-surface-2 p-3 font-mono text-xs text-fg"
          >
            {JSON.stringify(selected, null, 2)}
          </pre>
        ) : null}
      </Sheet>
    </div>
  );
}
