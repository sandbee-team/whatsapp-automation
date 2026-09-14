// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { RadioGroup } from '../src/radio-group.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const OPTIONS = [
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email', description: 'Sent to your inbox' },
  { value: 'push', label: 'Push notification' },
];

describe('RadioGroup', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a radiogroup with radios labelled from options', () => {
    render(
      <RadioGroup label="Delivery method" options={OPTIONS} value={null} onValueChange={vi.fn()} />,
    );
    screen.getByRole('radiogroup', { name: 'Delivery method' });
    screen.getByRole('radio', { name: 'SMS' });
    screen.getByRole('radio', { name: /Email/ });
    screen.getByRole('radio', { name: 'Push notification' });
  });

  it('renders option descriptions', () => {
    render(
      <RadioGroup label="Delivery method" options={OPTIONS} value={null} onValueChange={vi.fn()} />,
    );
    screen.getByText('Sent to your inbox');
  });

  it('reflects the selected value via aria-checked', () => {
    render(
      <RadioGroup
        label="Delivery method"
        options={OPTIONS}
        value="email"
        onValueChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: /Email/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'SMS' }).getAttribute('aria-checked')).toBe('false');
  });

  it('moves selection with arrow keys and calls onValueChange', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Delivery method"
        options={OPTIONS}
        value="sms"
        onValueChange={onValueChange}
      />,
    );
    screen.getByRole('radio', { name: 'SMS' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(onValueChange).toHaveBeenCalledWith('email', expect.anything());
  });

  it('toggles with Space when a radio receives focus directly', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        label="Delivery method"
        options={OPTIONS}
        value={null}
        onValueChange={onValueChange}
      />,
    );
    const pushRadio = screen.getByRole('radio', { name: 'Push notification' });
    pushRadio.focus();
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('push', expect.anything());
  });

  it('renders horizontal and vertical orientation', () => {
    render(
      <RadioGroup
        label="Delivery method"
        options={OPTIONS}
        value={null}
        onValueChange={vi.fn()}
        orientation="horizontal"
        data-testid="group"
      />,
    );
    expect(screen.getByTestId('group').className).toMatch(/flex-row/);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <RadioGroup label="Delivery method" options={OPTIONS} value="sms" onValueChange={vi.fn()} />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
