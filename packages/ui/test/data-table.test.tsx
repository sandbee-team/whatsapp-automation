// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '../src/data-table.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

interface Row {
  id: string;
  number: string;
  status: string;
}

const ROWS: Row[] = [
  { id: '1', number: '+91 90000 00000', status: 'Live' },
  { id: '2', number: '+91 90000 00001', status: 'Paused' },
  { id: '3', number: '+91 90000 00002', status: 'Live' },
];

const COLUMNS: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'number', header: 'Number', enableSorting: true, meta: { priority: 'high' } },
  { accessorKey: 'status', header: 'Status', meta: { priority: 'medium' } },
];

const LABELS = {
  previous: 'Previous',
  next: 'Next',
  pageOf: (page: number, pages: number) => `Page ${page} of ${pages}`,
};

describe('DataTable', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders rows from data', () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="Connected numbers" />);
    expect(screen.getByText('+91 90000 00000')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('clicking a sortable header toggles asc/desc and aria-sort', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLUMNS} data={ROWS} caption="Connected numbers" />);
    const headerCell = screen.getByRole('columnheader', { name: /Number/ });
    expect(headerCell.getAttribute('aria-sort')).toBe('none');
    const headerButton = within(headerCell).getByRole('button');
    await user.click(headerButton);
    expect(headerCell.getAttribute('aria-sort')).toBe('ascending');
    await user.click(headerButton);
    expect(headerCell.getAttribute('aria-sort')).toBe('descending');
  });

  it('client pagination moves pages and formats labels via props', async () => {
    const user = userEvent.setup();
    const manyRows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      number: `+91 9000000000${i}`,
      status: 'Live',
    }));
    render(
      <DataTable
        columns={COLUMNS}
        data={manyRows}
        caption="Connected numbers"
        pagination={{ mode: 'client', pageSize: 2, labels: LABELS }}
      />,
    );
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
  });

  it('loadMore pagination calls onLoadMore', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        caption="Connected numbers"
        pagination={{
          mode: 'loadMore',
          hasMore: true,
          isLoadingMore: false,
          onLoadMore,
          label: 'Load more',
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('isLoading renders exactly loadingRows skeleton rows', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        caption="Connected numbers"
        isLoading
        loadingRows={4}
      />,
    );
    const table = screen.getByRole('table');
    expect(table.getAttribute('aria-busy')).toBe('true');
    const skeletonRows = screen.getAllByTestId('data-table-skeleton-row');
    expect(skeletonRows).toHaveLength(4);
  });

  it('renders the empty state slot in a single full-width cell', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        caption="Connected numbers"
        emptyState={<span>No numbers connected yet</span>}
      />,
    );
    expect(screen.getByText('No numbers connected yet')).toBeTruthy();
  });

  it('0 rows + isLoading false renders the emptyState exactly once, never doubled with a body row', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        caption="Connected numbers"
        isLoading={false}
        emptyState={<span>No numbers connected yet</span>}
      />,
    );
    expect(screen.getAllByText('No numbers connected yet')).toHaveLength(1);
    // Exactly one row in the body: the empty-state row, no skeleton/data rows alongside it.
    const bodyRows = screen.getAllByRole('row');
    // getAllByRole('row') also includes the header row(s); with a single
    // header row + a single empty-state row, exactly 2 rows total exist.
    expect(bodyRows).toHaveLength(2);
  });

  it('loadMore mode never renders the client pager (no Previous/Next/page-of text)', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={ROWS}
        caption="Connected numbers"
        pagination={{
          mode: 'loadMore',
          hasMore: true,
          isLoadingMore: false,
          onLoadMore: vi.fn(),
          label: 'Load more',
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    expect(screen.queryByText(/Page \d+ of \d+/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });

  it('renders the error state slot in a single full-width cell', () => {
    render(
      <DataTable
        columns={COLUMNS}
        data={[]}
        caption="Connected numbers"
        errorState={<span>Could not load numbers</span>}
      />,
    );
    expect(screen.getByText('Could not load numbers')).toBeTruthy();
  });

  it('applies column priority classes for responsive hiding', () => {
    render(<DataTable columns={COLUMNS} data={ROWS} caption="Connected numbers" />);
    const statusHeader = screen.getByRole('columnheader', { name: 'Status' });
    expect(statusHeader.className).toContain('hidden');
    expect(statusHeader.className).toContain('md:table-cell');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <DataTable columns={COLUMNS} data={ROWS} caption="Connected numbers" />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
