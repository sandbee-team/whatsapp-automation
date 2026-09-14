// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { CommandPalette, type CommandPaletteItem } from '../src/command-palette.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function makeItems(onSelect: (id: string) => void): CommandPaletteItem[] {
  return [
    {
      id: 'go-dashboard',
      label: 'Go to dashboard',
      group: 'Navigation',
      onSelect: () => onSelect('go-dashboard'),
    },
    {
      id: 'go-contacts',
      label: 'Go to contacts',
      group: 'Navigation',
      keywords: ['audience', 'people'],
      onSelect: () => onSelect('go-contacts'),
    },
    {
      id: 'pause-instance',
      label: 'Pause instance',
      group: 'Actions',
      onSelect: () => onSelect('pause-instance'),
    },
  ];
}

function ControlledPalette({
  onSelect = () => {},
}: {
  onSelect?: (id: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(true);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      items={makeItems(onSelect)}
      placeholder="Search actions..."
      emptyLabel="No results found."
      inputLabel="Command palette search"
    />
  );
}

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders an input with role=combobox and aria wiring', () => {
    render(<ControlledPalette />);
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBeTruthy();
  });

  it('filters items by label (case-insensitive substring)', async () => {
    const user = userEvent.setup();
    render(<ControlledPalette />);
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.type(input, 'DASHBOARD');
    screen.getByText('Go to dashboard');
    expect(screen.queryByText('Pause instance')).toBeNull();
  });

  it('filters items by keywords', async () => {
    const user = userEvent.setup();
    render(<ControlledPalette />);
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.type(input, 'audience');
    screen.getByText('Go to contacts');
    expect(screen.queryByText('Go to dashboard')).toBeNull();
  });

  it('shows the empty label when nothing matches', async () => {
    const user = userEvent.setup();
    render(<ControlledPalette />);
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.type(input, 'zzz-nothing');
    screen.getByText('No results found.');
  });

  it('groups items by the group field', () => {
    render(<ControlledPalette />);
    screen.getByText('Navigation');
    screen.getByText('Actions');
  });

  it('ArrowDown/ArrowUp move the active option and wrap', async () => {
    const user = userEvent.setup();
    render(<ControlledPalette />);
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.click(input);
    // Starts on the first option (index 0).
    expect(input.getAttribute('aria-activedescendant')).toContain('go-dashboard');
    await user.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toContain('go-contacts');
    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toContain('go-dashboard');
    // ArrowUp from the first option wraps to the last option.
    await user.keyboard('{ArrowUp}');
    expect(input.getAttribute('aria-activedescendant')).toContain('pause-instance');
  });

  it('Enter runs the active item onSelect and closes', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        items={makeItems(onSelect)}
        placeholder="Search actions..."
        emptyLabel="No results found."
        inputLabel="Command palette search"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('go-dashboard');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Enter with zero matches is a no-op: no onSelect call and the palette stays open', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        items={makeItems(onSelect)}
        placeholder="Search actions..."
        emptyLabel="No results found."
        inputLabel="Command palette search"
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Command palette search' });
    await user.type(input, 'zzz-nothing');
    screen.getByText('No results found.');
    await user.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('Escape closes the palette', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        items={makeItems(() => {})}
        placeholder="Search actions..."
        emptyLabel="No results found."
        inputLabel="Command palette search"
      />,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has zero axe violations', async () => {
    const { container } = render(<ControlledPalette />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
