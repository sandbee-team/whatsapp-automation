// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PasswordInput } from '../src/password-input.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('PasswordInput', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders type="password" by default', () => {
    render(<PasswordInput label="Password" showLabel="Show password" hideLabel="Hide password" />);
    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('type')).toBe('password');
  });

  it('toggles the input type and sets aria-pressed on the toggle button', async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Password" showLabel="Show password" hideLabel="Hide password" />);
    const input = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    await user.click(toggle);
    expect(input.getAttribute('type')).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    screen.getByRole('button', { name: 'Hide password' });

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input.getAttribute('type')).toBe('password');
  });

  it('forwards ref to the underlying input element', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<PasswordInput label="Password" showLabel="Show" hideLabel="Hide" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <PasswordInput label="Password" showLabel="Show password" hideLabel="Hide password" />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
