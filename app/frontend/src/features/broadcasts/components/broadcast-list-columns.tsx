import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import {
  Badge,
  DropdownMenu,
  useT,
  type BadgeTone,
  type DataTableColumnMeta,
  type DropdownMenuItem,
} from '@wp/ui';
import type { ColumnDef } from '@tanstack/react-table';
import type { BroadcastStatus } from '@wp/domain';
import { paiseToRupees } from '../../wallet/money.js';
import type { BroadcastSummary } from '../api.js';

/**
 * Column + row-action definitions for `BroadcastList` (`broadcast-list.tsx`),
 * split out to keep the parent file under the 300-line cap. No behaviour
 * change from the P26b U4 restyle - same `broadcast-row-{id}` test id idiom,
 * same status tone map, same pause/resume/cancel gating by
 * `BroadcastSummary.status`.
 */

export const STATUS_TONES: Record<BroadcastStatus, BadgeTone> = {
  draft: 'neutral',
  scheduled: 'info',
  snapshotting: 'info',
  expanding: 'info',
  running: 'accent',
  paused: 'warning',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

export type PendingBroadcastAction = {
  broadcast: BroadcastSummary;
  action: 'pause' | 'resume' | 'cancel';
} | null;

export function useBroadcastListColumns(
  t: ReturnType<typeof useT>,
  setPendingAction: (value: PendingBroadcastAction) => void,
): ColumnDef<BroadcastSummary, unknown>[] {
  return React.useMemo(
    () => [
      {
        id: 'name',
        header: t('broadcasts.list.col.name'),
        accessorKey: 'name',
        cell: ({ row }) => (
          // The `data-testid` marks the ROW's identity (existing suite's
          // `broadcast-row-{id}` selector) - `DataTable`'s generated `<tr>`
          // has no per-row attrs hook, so it lives on this cell's wrapper
          // instead; `getAllByTestId` matches any element, not only `<tr>`.
          <span data-testid={`broadcast-row-${row.original.id}`}>
            <Link to="/broadcasts/$id" params={{ id: row.original.id }} className="hover:underline">
              {row.original.name}
            </Link>
          </span>
        ),
      },
      {
        id: 'status',
        header: t('broadcasts.list.col.status'),
        accessorKey: 'status',
        cell: ({ row }) => (
          <Badge tone={STATUS_TONES[row.original.status]}>
            {t(`broadcasts.status.${row.original.status}`)}
          </Badge>
        ),
      },
      {
        id: 'audienceCount',
        header: t('broadcasts.list.col.audience'),
        accessorKey: 'audienceCount',
        meta: { priority: 'medium', align: 'right' } satisfies DataTableColumnMeta,
        cell: ({ row }) => row.original.audienceCount ?? '—',
      },
      {
        id: 'quoteMinor',
        header: t('broadcasts.list.col.quote'),
        accessorKey: 'quoteMinor',
        meta: { priority: 'low', align: 'right' } satisfies DataTableColumnMeta,
        cell: ({ row }) =>
          row.original.quoteMinor !== null ? paiseToRupees(row.original.quoteMinor) : '—',
      },
      {
        id: 'createdAt',
        header: t('broadcasts.list.col.created'),
        accessorKey: 'createdAt',
        meta: { priority: 'low' } satisfies DataTableColumnMeta,
      },
      {
        id: 'actions',
        header: t('broadcasts.list.col.actions'),
        cell: ({ row }) => (
          <RowActionsMenu broadcast={row.original} t={t} setPendingAction={setPendingAction} />
        ),
      },
    ],
    [t, setPendingAction],
  );
}

function RowActionsMenu({
  broadcast,
  t,
  setPendingAction,
}: {
  broadcast: BroadcastSummary;
  t: ReturnType<typeof useT>;
  setPendingAction: (value: PendingBroadcastAction) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const items: DropdownMenuItem[] = [
    {
      id: 'open',
      label: t('broadcasts.list.actions.open'),
      onSelect: () => {
        // Row navigation stays on the name link; this entry is a
        // keyboard/menu-accessible duplicate of the same destination via the
        // typed router (never a raw location assignment).
        void navigate({ to: '/broadcasts/$id', params: { id: broadcast.id } });
      },
    },
  ];

  if (broadcast.status === 'running' || broadcast.status === 'expanding') {
    items.push({ separator: true });
    items.push({
      id: 'pause',
      label: t('broadcasts.list.actions.pause'),
      onSelect: () => setPendingAction({ broadcast, action: 'pause' }),
    });
  }
  if (broadcast.status === 'paused') {
    items.push({ separator: true });
    items.push({
      id: 'resume',
      label: t('broadcasts.list.actions.resume'),
      onSelect: () => setPendingAction({ broadcast, action: 'resume' }),
    });
  }
  const terminal: BroadcastStatus[] = ['completed', 'cancelled', 'failed'];
  if (!terminal.includes(broadcast.status)) {
    items.push({ separator: true });
    items.push({
      id: 'cancel',
      label: t('broadcasts.list.actions.cancel'),
      destructive: true,
      onSelect: () => setPendingAction({ broadcast, action: 'cancel' }),
    });
  }

  return (
    <DropdownMenu
      trigger={
        <button
          type="button"
          aria-label={t('broadcasts.list.actions.label')}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
        >
          <MoreHorizontal aria-hidden="true" size={16} />
        </button>
      }
      items={items}
      align="end"
    />
  );
}
