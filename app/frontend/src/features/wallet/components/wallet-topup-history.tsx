import { Badge, DataTable, EmptyState, ErrorState, useLocale, useT, type BadgeTone } from '@wp/ui';
import type { ColumnDef } from '@tanstack/react-table';
import { History } from 'lucide-react';
import { useTopupRequests, type TopupRequestItem } from '../api.js';
import { paiseToRupees } from '../money.js';

/**
 * WalletTopupHistory (P26b U5) - `GET /v1/wallet/topup-requests` rendered
 * as a `DataTable`: amount (paise -> rupees via `paiseToRupees`, never a
 * float division), status badge (pending/approved/rejected, tone + text -
 * never colour alone), the submission date and an optional note. Only real
 * fields from `topupRequestItemSchema` are rendered (`id`, `amountMinor`,
 * `status`, `note?`, `createdAt`) - there is no `method` field on this type.
 * Honest loading (skeleton rows shaped like the final table) / empty / error
 * states, same discipline as every other list in this unit.
 */
const STATUS_TONE: Record<TopupRequestItem['status'], BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
};

export function WalletTopupHistory(): React.JSX.Element {
  const t = useT();
  const locale = useLocale();
  const { data, isLoading, isError, refetch } = useTopupRequests();
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const columns: ColumnDef<TopupRequestItem, unknown>[] = [
    {
      id: 'amount',
      header: t('wallet.history.column.amount'),
      cell: ({ row }) => paiseToRupees(Number(row.original.amountMinor)),
    },
    {
      id: 'status',
      header: t('wallet.history.column.status'),
      cell: ({ row }) => (
        <Badge tone={STATUS_TONE[row.original.status]}>
          {t(`wallet.topup.status${capitalize(row.original.status)}` as never)}
        </Badge>
      ),
    },
    {
      id: 'createdAt',
      header: t('wallet.history.column.createdAt'),
      cell: ({ row }) => dateFormatter.format(new Date(row.original.createdAt)),
      meta: { priority: 'low' },
    },
    {
      id: 'note',
      header: t('wallet.history.column.note'),
      cell: ({ row }) => row.original.note ?? '—',
      meta: { priority: 'low' },
    },
  ];

  return (
    <div data-testid="wallet-topup-history" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold font-ui text-fg">{t('wallet.history.title')}</h2>
      <DataTable
        caption={t('wallet.history.title')}
        columns={columns}
        data={data ?? []}
        isLoading={isLoading}
        getRowId={(row) => row.id}
        emptyState={
          <EmptyState
            compact
            icon={<History aria-hidden size={20} />}
            title={t('wallet.history.empty.title')}
            body={t('wallet.history.empty.body')}
          />
        }
        errorState={
          isError ? (
            <ErrorState
              title={t('wallet.history.error')}
              retryAction={
                <button
                  type="button"
                  data-testid="wallet-history-retry"
                  onClick={() => void refetch()}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  {t('common.retry')}
                </button>
              }
            />
          ) : undefined
        }
      />
    </div>
  );
}

function capitalize<T extends string>(value: T): Capitalize<T> {
  return (value.charAt(0).toUpperCase() + value.slice(1)) as Capitalize<T>;
}
