// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Checkbox } from '../src/checkbox.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Checkbox', () => {
  afterEach(() => {
    cleanup();
  });

  it('associates the label and starts unchecked', () => {
    render(<Checkbox label="Accept terms" />);
    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
  });

  it('renders a description', () => {
    render(<Checkbox label="Accept terms" description="Read the terms first" />);
    screen.getByText('Read the terms first');
  });

  it('toggles with Space and calls onCheckedChange', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Checkbox label="Accept terms" onCheckedChange={onCheckedChange} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Accept terms' });
    checkbox.focus();
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('supports indeterminate state', () => {
    render(<Checkbox label="Select all" indeterminate />);
    const checkbox = screen.getByRole('checkbox', { name: 'Select all' });
    expect(checkbox.getAttribute('aria-checked')).toBe('mixed');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Checkbox label="Accept terms" description="Read the terms first" />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
