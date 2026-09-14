// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Select } from '../src/select.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const OPTIONS = [
  { value: 'sales', label: 'Sales' },
  { value: 'support', label: 'Support', description: 'Front-line support team' },
  { value: 'ops', label: 'Operations', disabled: true },
];

describe('Select', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a real button trigger labelled by the field label', () => {
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={vi.fn()}
      />,
    );
    screen.getByRole('combobox', { name: /Team/ });
  });

  it('shows the placeholder when no value is selected', () => {
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={vi.fn()}
      />,
    );
    screen.getByText('Choose a team');
  });

  it('opens the popup on click and selects an option, calling onValueChange', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: /Team/ }));
    const option = await screen.findByRole('option', { name: 'Sales' });
    await user.click(option);
    expect(onValueChange).toHaveBeenCalledWith('sales', expect.anything());
  });

  it('opens with the keyboard and selects with ArrowDown then Enter', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: /Team/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('option', { name: 'Sales' });
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it('sets aria-invalid on the trigger when error is set', () => {
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={vi.fn()}
        error="A team is required."
      />,
    );
    const trigger = screen.getByRole('combobox', { name: /Team/ });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    screen.getByText('A team is required.');
  });

  it('renders the currently selected option label in the trigger', () => {
    render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value="support"
        onValueChange={vi.fn()}
      />,
    );
    screen.getByText('Support');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Select
        label="Team"
        placeholder="Choose a team"
        options={OPTIONS}
        value={null}
        onValueChange={vi.fn()}
        description="Pick the team that owns this conversation."
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
