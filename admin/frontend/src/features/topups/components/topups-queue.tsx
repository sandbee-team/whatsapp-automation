import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Wallet } from 'lucide-react';
import { Button, DataTable, EmptyState, ErrorState, Tabs, useT } from '@wp/ui';
import { PageHeader } from '../../../components/page-header.js';
import { StaffActionDialog } from '../../../components/staff-action-dialog.js';
import { useStaffMe } from '../../../lib/use-staff-me.js';
import { formatPaiseAsRupees } from '../../../lib/money.js';
import {
  approveTopup,
  listTopups,
  rejectTopup,
  type AdminTopupItem,
  type TopupStatus,
} from '../api.js';
import { topupKeys } from '../keys.js';

/**
 * topups-queue.tsx (P28 Unit U6, step 9) - the `/topups` screen. THE API
 * SENDS NO EXTERNAL REF - `adminTopupItemSchema` never carries one, so this
 * table cannot render one even from a malicious/drifted payload (the schema
 * parse in `features/topups/api.ts` is the real enforcement).
 */
export function TopupsQueue(): React.JSX.Element {
  const t = useT();
  const { canDo } = useStaffMe();
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<TopupStatus>('pending');
  const [actionTarget, setActionTarget] = React.useState<{
    id: string;
    kind: 'approve' | 'reject';
  } | null>(null);

  const query = useQuery({
    queryKey: topupKeys.list(status),
    queryFn: () => listTopups(status),
  });

  const canApprove = canDo('topups.approve');
  const canReject = canDo('topups.reject');

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: topupKeys.list(status) }).then(() => undefined);

  const columns: ColumnDef<AdminTopupItem, unknown>[] = [
    { accessorKey: 'clientId', header: t('admin.topups.table.client') },
    {
      id: 'amount',
      header: t('admin.topups.table.amount'),
      cell: ({ row }) => formatPaiseAsRupees(row.original.amountMinor),
    },
    { accessorKey: 'method', header: t('admin.topups.table.method') },
    {
      id: 'createdAt',
      header: t('admin.topups.table.created'),
      cell: ({ row }) => new Date(row.original.createdAt).toLocaleString(),
    },
    ...(status === 'pending'
      ? [
          {
            id: 'actions',
            header: '',
            cell: ({ row }: { row: { original: AdminTopupItem } }) => (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid={`topup-approve-${row.original.id}`}
                  disabled={!canApprove}
                  title={canApprove ? undefined : t('admin.roleTooltip.disabled')}
                  onClick={() => setActionTarget({ id: row.original.id, kind: 'approve' })}
                >
                  {t('admin.topups.approve.button')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`topup-reject-${row.original.id}`}
                  disabled={!canReject}
                  title={canReject ? undefined : t('admin.roleTooltip.disabled')}
                  onClick={() => setActionTarget({ id: row.original.id, kind: 'reject' })}
                >
                  {t('admin.topups.reject.button')}
                </Button>
              </div>
            ),
          } satisfies ColumnDef<AdminTopupItem, unknown>,
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader title={t('admin.topups.title')} description={t('admin.topups.description')} />

      <Tabs
        value={status}
        onValueChange={(value) => setStatus(value as TopupStatus)}
        tabs={[
          { value: 'pending', label: t('admin.topups.tab.pending') },
          { value: 'approved', label: t('admin.topups.tab.approved') },
          { value: 'rejected', label: t('admin.topups.tab.rejected') },
        ]}
      />

      <div className="mt-4">
        <DataTable
          caption={t('admin.topups.table.caption')}
          columns={columns}
          data={query.data?.items ?? []}
          isLoading={query.isLoading}
          getRowId={(row) => row.id}
          errorState={
            query.isError ? (
              <ErrorState
                title={t('admin.common.errorGeneric')}
                retryAction={
                  <button
                    type="button"
                    data-testid="topups-retry"
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
              icon={<Wallet aria-hidden size={24} />}
              title={t('admin.topups.empty.title')}
            />
          }
        />
      </div>

      <StaffActionDialog
        open={actionTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActionTarget(null);
        }}
        title={
          actionTarget?.kind === 'approve'
            ? t('admin.topups.approve.title')
            : t('admin.topups.reject.title')
        }
        destructive={actionTarget?.kind === 'reject'}
        successMessage={t('admin.common.successGeneric')}
        onSubmit={async (reason, idempotencyKey) => {
          if (!actionTarget) return;
          if (actionTarget.kind === 'approve') {
            await approveTopup(actionTarget.id, reason, idempotencyKey);
          } else {
            await rejectTopup(actionTarget.id, reason, idempotencyKey);
          }
          await refresh();
        }}
      />
    </div>
  );
}
