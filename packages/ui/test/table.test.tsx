// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Table, THead, TBody, TR, TH, TD, TableContainer } from '../src/table.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function renderTable(props: { dense?: boolean; zebra?: boolean } = {}) {
  return render(
    <TableContainer>
      <Table caption="Connected numbers" {...props}>
        <THead>
          <TR>
            <TH>Number</TH>
            <TH>Status</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>+91 90000 00000</TD>
            <TD>Live</TD>
          </TR>
          <TR>
            <TD>+91 90000 00001</TD>
            <TD>Paused</TD>
          </TR>
        </TBody>
      </Table>
    </TableContainer>,
  );
}

describe('Table', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a caption, sticky thead styling and rows', () => {
    renderTable();
    const table = screen.getByRole('table', { name: 'Connected numbers' });
    expect(table).toBeTruthy();
    const columnHeader = screen.getByRole('columnheader', { name: 'Number' });
    expect(columnHeader.getAttribute('scope')).toBe('col');
    expect(screen.getByText('+91 90000 00000')).toBeTruthy();
  });

  it('wraps the table in a rounded bordered container with horizontal scroll', () => {
    const { container } = renderTable();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('overflow-x-auto');
    expect(wrapper.className).toContain('rounded-lg');
    expect(wrapper.className).toContain('border');
  });

  it('applies dense row height classes when dense is set', () => {
    renderTable({ dense: true });
    const rows = screen.getAllByRole('row');
    // Skip header row; body rows should carry the dense height class.
    const bodyRow = rows[1];
    expect(bodyRow.className).toContain('h-9');
  });

  it('defaults to h-11 rows and applies zebra striping when requested', () => {
    renderTable({ zebra: true });
    const rows = screen.getAllByRole('row');
    const bodyRow = rows[1];
    expect(bodyRow.className).toContain('h-11');
    const secondBodyRow = rows[2];
    expect(secondBodyRow.className).toContain('even:bg-surface-2/40');
  });

  it('has zero axe violations', async () => {
    const { container } = renderTable();
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
