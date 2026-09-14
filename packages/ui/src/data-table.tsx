'use client';

import * as React from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { cx } from './lib/cx.js';
import { TableContainer, Table, THead, TBody, TR, TD } from './table.js';
import {
  HeaderRow,
  BodyRow,
  SkeletonRows,
  PaginationFooter,
  type ClientPaginationProps,
  type LoadMorePaginationProps,
} from './data-table-parts.js';

/**
 * DataTable - generic TanStack Table v8 wrapper. `caption` is required
 * (accessible table name, forwarded to `Table`). `isLoading` renders exactly
 * `loadingRows` (default: `pagination.pageSize` when in `client` mode, else
 * 8) skeleton rows and sets `aria-busy` on the table; `emptyState`/
 * `errorState` render in a single full-width cell when supplied and there is
 * no data. Sorting is uncontrolled client sorting unless `sorting.state`/
 * `sorting.onChange` are supplied. `columnPriority` classes come from each
 * column's `meta.priority`.
 */
export interface DataTableRowSelection {
  enabled: boolean;
  selected: Record<string, boolean>;
  onChange: (selected: Record<string, boolean>) => void;
}

export interface DataTableSorting {
  state: SortingState;
  onChange: (state: SortingState) => void;
}

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  caption: string;
  isLoading?: boolean;
  loadingRows?: number;
  emptyState?: React.ReactNode;
  errorState?: React.ReactNode;
  getRowId?: (row: TData, index: number) => string;
  onRowClick?: (row: TData) => void;
  rowSelection?: DataTableRowSelection;
  sorting?: DataTableSorting;
  pagination?: ClientPaginationProps | LoadMorePaginationProps;
  toolbar?: React.ReactNode;
  className?: string;
}

export function DataTable<TData>({
  columns,
  data,
  caption,
  isLoading = false,
  loadingRows,
  emptyState,
  errorState,
  getRowId,
  onRowClick,
  rowSelection,
  sorting,
  pagination,
  toolbar,
  className,
}: DataTableProps<TData>): React.JSX.Element {
  const [internalSorting, setInternalSorting] = React.useState<SortingState>([]);
  const sortingState = sorting?.state ?? internalSorting;
  const pageSize = pagination?.mode === 'client' ? pagination.pageSize : data.length || 1;

  const table = useReactTable({
    data,
    columns,
    state: { sorting: sortingState },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sortingState) : updater;
      if (sorting) sorting.onChange(next);
      else setInternalSorting(next);
    },
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: pagination?.mode === 'client' ? getPaginationRowModel() : undefined,
    initialState: { pagination: { pageSize } },
  });

  const rows =
    pagination?.mode === 'client' ? table.getPaginationRowModel().rows : table.getRowModel().rows;
  const columnCount = columns.length + (rowSelection?.enabled ? 1 : 0);
  const resolvedLoadingRows =
    loadingRows ?? (pagination?.mode === 'client' ? pagination.pageSize : 8);
  const showEmpty = !isLoading && !errorState && rows.length === 0 && Boolean(emptyState);
  const showError = !isLoading && Boolean(errorState);

  return (
    <div className={cx('flex flex-col gap-3', className)}>
      {toolbar ? <div className="flex items-center justify-between gap-3">{toolbar}</div> : null}
      <TableContainer>
        <Table caption={caption} aria-busy={isLoading || undefined}>
          <THead>
            {table.getHeaderGroups().map((headerGroup) => (
              <HeaderRow key={headerGroup.id} headerGroup={headerGroup} />
            ))}
          </THead>
          <TBody>
            {isLoading ? (
              <SkeletonRows rows={resolvedLoadingRows} columnCount={columnCount} />
            ) : showError ? (
              <TR>
                <TD colSpan={columnCount}>{errorState}</TD>
              </TR>
            ) : showEmpty ? (
              <TR>
                <TD colSpan={columnCount}>{emptyState}</TD>
              </TR>
            ) : (
              rows.map((row) => (
                <BodyRow
                  key={row.id}
                  row={row}
                  onRowClick={onRowClick}
                  selectable={rowSelection?.enabled}
                  selected={Boolean(rowSelection?.selected[row.id])}
                  onToggleSelected={(rowId, next) => {
                    if (!rowSelection) return;
                    rowSelection.onChange({ ...rowSelection.selected, [rowId]: next });
                  }}
                />
              ))
            )}
          </TBody>
        </Table>
      </TableContainer>
      {pagination && !isLoading && !showError && !showEmpty ? (
        <PaginationFooter pagination={pagination} table={table} />
      ) : null}
    </div>
  );
}
