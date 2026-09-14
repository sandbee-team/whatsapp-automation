// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Switch } from '../src/switch.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Switch', () => {
  afterEach(() => {
    cleanup();
  });

  it('associates the label and starts unchecked', () => {
    render(<Switch label="Enable notifications" />);
    const toggle = screen.getByRole('switch', { name: 'Enable notifications' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('toggles with Space and calls onCheckedChange', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch label="Enable notifications" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole('switch', { name: 'Enable notifications' });
    toggle.focus();
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('supports sm and md sizes', () => {
    render(
      <>
        <Switch label="Small" size="sm" data-testid="small" />
        <Switch label="Medium" size="md" data-testid="medium" />
      </>,
    );
    expect(screen.getByTestId('small').className).toMatch(/h-5/);
    expect(screen.getByTestId('medium').className).toMatch(/h-6/);
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Switch label="Enable notifications" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
