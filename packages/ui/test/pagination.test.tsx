// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Pagination } from '../src/pagination.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const LABELS = {
  previous: 'Previous',
  next: 'Next',
  page: (n: number) => `Page ${n}`,
};

describe('Pagination', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders numbered page buttons with aria-current on the active page', () => {
    render(<Pagination page={2} pageCount={5} onPageChange={vi.fn()} labels={LABELS} />);
    const current = screen.getByRole('button', { name: 'Page 2' });
    expect(current.getAttribute('aria-current')).toBe('page');
    const other = screen.getByRole('button', { name: 'Page 3' });
    expect(other.getAttribute('aria-current')).toBeNull();
  });

  it('calls onPageChange when a page button is clicked', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageCount={3} onPageChange={onPageChange} labels={LABELS} />);
    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('previous is disabled on the first page and next disabled on the last page', () => {
    render(<Pagination page={1} pageCount={3} onPageChange={vi.fn()} labels={LABELS} />);
    expect(screen.getByRole('button', { name: 'Previous' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false);
  });

  it('clicking next/previous moves the page by one', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination page={2} pageCount={5} onPageChange={onPageChange} labels={LABELS} />);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(3);
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('collapses a long page range with an ellipsis', () => {
    render(<Pagination page={5} pageCount={20} onPageChange={vi.fn()} labels={LABELS} />);
    expect(screen.getAllByText('…').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Page 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Page 20' })).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Pagination page={2} pageCount={5} onPageChange={vi.fn()} labels={LABELS} />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
