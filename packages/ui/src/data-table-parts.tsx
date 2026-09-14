'use client';

import * as React from 'react';
import {
  flexRender,
  type Header,
  type Row,
  type Table as TanstackTable,
} from '@tanstack/react-table';
import { cx } from './lib/cx.js';
import { TableContainer, Table, THead, TBody, TR, TH, TD } from './table.js';
import { Pagination, type PaginationLabels } from './pagination.js';

/**
 * data-table-parts - rendering helpers split out of `data-table.tsx` to stay
 * under the 300-line cap: header cells (sortable button + `aria-sort`), body
 * rows (with priority classes + row click/selection), skeleton rows, and the
 * two pagination-footer variants (`client` / `loadMore`).
 */
type ColumnPriority = 'high' | 'medium' | 'low';
type ColumnAlign = 'left' | 'right';

export interface DataTableColumnMeta {
  priority?: ColumnPriority;
  align?: ColumnAlign;
  width?: string;
}

const PRIORITY_CLASSES: Record<ColumnPriority, string> = {
  high: '',
  medium: 'hidden md:table-cell',
  low: 'hidden lg:table-cell',
};

export function priorityClass(meta: DataTableColumnMeta | undefined): string {
  return meta?.priority ? PRIORITY_CLASSES[meta.priority] : '';
}

export function alignClass(meta: DataTableColumnMeta | undefined): string {
  return meta?.align === 'right' ? 'text-right' : '';
}

function sortAria(sorted: 'asc' | 'desc' | false): 'ascending' | 'descending' | 'none' {
  if (sorted === 'asc') return 'ascending';
  if (sorted === 'desc') return 'descending';
  return 'none';
}

export function HeaderRow<TData>({
  headerGroup,
}: {
  headerGroup: { headers: Header<TData, unknown>[] };
}): React.JSX.Element {
  return (
    <TR>
      {headerGroup.headers.map((header) => {
        const meta = header.column.columnDef.meta as DataTableColumnMeta | undefined;
        const canSort = header.column.getCanSort();
        const sorted = header.column.getIsSorted();
        return (
          <TH
            key={header.id}
            aria-sort={canSort ? sortAria(sorted) : undefined}
            style={meta?.width ? { width: meta.width } : undefined}
            className={cx(priorityClass(meta), alignClass(meta))}
          >
            {header.isPlaceholder ? null : canSort ? (
              <button
                type="button"
                onClick={header.column.getToggleSortingHandler()}
                className="inline-flex items-center gap-1 font-medium hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
              >
                {flexRender(header.column.columnDef.header, header.getContext())}
              </button>
            ) : (
              flexRender(header.column.columnDef.header, header.getContext())
            )}
          </TH>
        );
      })}
    </TR>
  );
}

export function BodyRow<TData>({
  row,
  onRowClick,
  selectable,
  selected,
  onToggleSelected,
}: {
  row: Row<TData>;
  onRowClick?: (row: TData) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (rowId: string, next: boolean) => void;
}): React.JSX.Element {
  return (
    <TR
      onClick={onRowClick ? () => onRowClick(row.original) : undefined}
      className={cx(onRowClick && 'cursor-pointer', selected && 'bg-accent-soft/40')}
    >
      {selectable ? (
        <TD>
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={(event) => onToggleSelected?.(row.id, event.target.checked)}
            onClick={(event) => event.stopPropagation()}
            aria-label="Select row"
          />
        </TD>
      ) : null}
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta as DataTableColumnMeta | undefined;
        return (
          <TD key={cell.id} className={cx(priorityClass(meta), alignClass(meta))}>
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TD>
        );
      })}
    </TR>
  );
}

export function SkeletonRows({
  rows,
  columnCount,
}: {
  rows: number;
  columnCount: number;
}): React.JSX.Element {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TR key={rowIndex} aria-hidden="true" data-testid="data-table-skeleton-row">
          {Array.from({ length: columnCount }, (_, colIndex) => (
            <TD key={colIndex}>
              <div className="h-3 w-full animate-pulse rounded-md bg-surface-2" />
            </TD>
          ))}
        </TR>
      ))}
    </>
  );
}

export interface ClientPaginationProps {
  mode: 'client';
  pageSize: number;
  labels: { previous: string; next: string; pageOf: (page: number, pages: number) => string };
}

export interface LoadMorePaginationProps {
  mode: 'loadMore';
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  label: string;
}

export function PaginationFooter<TData>({
  pagination,
  table,
}: {
  pagination: ClientPaginationProps | LoadMorePaginationProps;
  table: TanstackTable<TData>;
}): React.JSX.Element {
  if (pagination.mode === 'loadMore') {
    return (
      <div className="flex justify-center p-3">
        <button
          type="button"
          disabled={!pagination.hasMore || pagination.isLoadingMore}
          onClick={pagination.onLoadMore}
          className="inline-flex h-9 items-center rounded-md border border-border-strong px-4 text-sm font-ui text-fg hover:bg-surface-2 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        >
          {pagination.label}
        </button>
      </div>
    );
  }
  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const paginationLabels: PaginationLabels = {
    previous: pagination.labels.previous,
    next: pagination.labels.next,
    page: (n) => pagination.labels.pageOf(n, pageCount),
  };
  return (
    <div className="flex items-center justify-end p-3">
      <Pagination
        page={pageIndex + 1}
        pageCount={Math.max(pageCount, 1)}
        onPageChange={(page) => table.setPageIndex(page - 1)}
        labels={paginationLabels}
      />
    </div>
  );
}

export { TableContainer, Table, THead, TBody };
