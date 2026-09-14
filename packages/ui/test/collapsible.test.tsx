// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Collapsible } from '../src/collapsible.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Collapsible', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the trigger label and toggles the panel on click', async () => {
    const user = userEvent.setup();
    render(
      <Collapsible trigger="Advanced options">
        <p>Hidden content</p>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: 'Advanced options' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    screen.getByText('Hidden content');
  });

  it('calls onOpenChange when toggled', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Collapsible trigger="Advanced options" onOpenChange={onOpenChange}>
        <p>Hidden content</p>
      </Collapsible>,
    );
    await user.click(screen.getByRole('button', { name: 'Advanced options' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Collapsible trigger="Advanced options">
        <p>Hidden content</p>
      </Collapsible>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
