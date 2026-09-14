import * as React from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  ErrorState,
  Skeleton,
  useT,
  type DataTableColumnMeta,
} from '@wp/ui';
import {
  UNRESOLVED_DISCARD_BUTTON_COPY,
  UNRESOLVED_EXPLANATION_COPY,
  UNRESOLVED_RETRY_BUTTON_COPY,
} from '@wp/domain';
import type { ColumnDef } from '@tanstack/react-table';
import { useUnresolvedSends, type UnresolvedRowState } from './useUnresolvedSends.js';

/**
 * UnresolvedSendsPanel (P12 U6a, step 9; P26b U4 restyle) - per-instance
 * "Unresolved sends" list, pure render (`useUnresolvedSends.ts` owns all
 * state/API calls, same split idiom as `Composer.tsx`/`useComposer.ts`).
 * Exactly two buttons per row, canon copy imported from `@wp/domain` and
 * rendered verbatim - never retyped - following the `PARKED_COPY`/
 * `COMPOSER_QUEUED_COPY` precedent (raw JSX interpolation, not routed
 * through `t()`; canon copy is not translated in v1). The explanation is
 * always visible text, never behind a tooltip or an `AlertDialog` confirm -
 * a human is being asked to make an irreversible choice and every row's
 * consequence is already spelled out in each button's own label.
 *
 * PRIVACY: a row shows only its public id and timestamp
 * (`useUnresolvedSends.ts`'s `UnresolvedRowState` - see `api.ts`'s doc for
 * why no phone/JID/body field exists to render even by mistake).
 *
 * Rows render as a `DataTable` once loaded; the `-loading`/`-error`/`-empty`
 * test ids stay on whichever element plays that role today.
 */
export interface UnresolvedSendsPanelProps {
  instanceId: string;
}

export function UnresolvedSendsPanel({ instanceId }: UnresolvedSendsPanelProps): React.JSX.Element {
  const t = useT();
  const unresolved = useUnresolvedSends(instanceId);

  const columns: ColumnDef<UnresolvedRowState, unknown>[] = [
    {
      id: 'jobPublicId',
      header: t('unresolved.panel.title'),
      accessorKey: 'jobPublicId',
      cell: ({ row }) => <span className="font-mono text-xs">{row.original.jobPublicId}</span>,
    },
    {
      id: 'createdAt',
      header: '',
      accessorKey: 'createdAt',
      meta: { priority: 'medium' } satisfies DataTableColumnMeta,
      cell: ({ row }) => <span className="text-xs text-muted">{row.original.createdAt}</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => <UnresolvedRowActions row={row.original} unresolved={unresolved} />,
    },
  ];

  return (
    <Card data-testid="unresolved-sends-panel">
      <CardBody className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold font-ui text-fg">{t('unresolved.panel.title')}</h2>
          <Badge tone="neutral" data-testid="unresolved-count">
            {unresolved.count}
          </Badge>
        </div>

        <p className="text-sm font-ui text-fg">{UNRESOLVED_EXPLANATION_COPY}</p>

        {unresolved.stage === 'loading' ? (
          <div data-testid="unresolved-loading" className="flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : null}

        {unresolved.stage === 'error' ? (
          <ErrorState
            data-testid="unresolved-error"
            title={t('unresolved.panel.error')}
            role="alert"
          />
        ) : null}

        {unresolved.stage === 'ready' && unresolved.rows.length === 0 ? (
          <EmptyState data-testid="unresolved-empty" title={t('unresolved.panel.empty')} compact />
        ) : null}

        {unresolved.stage === 'ready' && unresolved.rows.length > 0 ? (
          <DataTable
            columns={columns}
            data={unresolved.rows}
            caption={t('unresolved.panel.title')}
            getRowId={(row) => row.jobPublicId}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

function UnresolvedRowActions({
  row,
  unresolved,
}: {
  row: UnresolvedRowState;
  unresolved: ReturnType<typeof useUnresolvedSends>;
}): React.JSX.Element {
  const t = useT();
  return (
    <div
      data-testid={`unresolved-row-${row.jobPublicId}`}
      className="flex items-center justify-end gap-2"
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid={`unresolved-retry-${row.jobPublicId}`}
        loading={row.pendingAction === 'retry'}
        loadingLabel={t('common.loading')}
        disabled={row.pendingAction !== null}
        onClick={() => unresolved.retryRow(row.jobPublicId)}
      >
        {UNRESOLVED_RETRY_BUTTON_COPY}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="danger"
        data-testid={`unresolved-discard-${row.jobPublicId}`}
        loading={row.pendingAction === 'discard'}
        loadingLabel={t('common.loading')}
        disabled={row.pendingAction !== null}
        onClick={() => unresolved.discardRow(row.jobPublicId)}
      >
        {UNRESOLVED_DISCARD_BUTTON_COPY}
      </Button>
    </div>
  );
}
