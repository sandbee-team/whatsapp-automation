// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { DropdownMenu, type DropdownMenuItem } from '../src/dropdown-menu.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function makeItems(onSelect: (id: string) => void): DropdownMenuItem[] {
  return [
    { id: 'rename', label: 'Rename' },
    { id: 'archive', label: 'Archive' },
    { separator: true },
    { group: 'Danger zone' },
    { id: 'delete', label: 'Delete', destructive: true },
  ].map((item) =>
    'id' in item ? { ...item, onSelect: () => onSelect(item.id) } : item,
  ) as DropdownMenuItem[];
}

describe('DropdownMenu', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens on trigger click', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(() => {})} />,
    );
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await waitFor(() => screen.getByRole('menu'));
  });

  it('ArrowDown highlights the next item and Enter selects it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(onSelect)} />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await waitFor(() => screen.getByRole('menu'));
    await user.keyboard('{ArrowDown}');
    const rename = screen.getByRole('menuitem', { name: 'Rename' });
    await waitFor(() => expect(rename.getAttribute('data-highlighted')).not.toBeNull());
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('rename');
  });

  it('Escape closes the menu', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(() => {})} />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await waitFor(() => screen.getByRole('menu'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('destructive item has the danger text class', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(() => {})} />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const deleteItem = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(deleteItem.className).toMatch(/text-danger/);
  });

  it('renders the group label', async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(() => {})} />,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await screen.findByText('Danger zone');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <DropdownMenu trigger={<button type="button">Actions</button>} items={makeItems(() => {})} />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
