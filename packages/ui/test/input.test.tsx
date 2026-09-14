// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Search } from 'lucide-react';
import { Input } from '../src/input.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Input', () => {
  afterEach(() => {
    cleanup();
  });

  it('associates the required label via htmlFor/id', () => {
    render(<Input label="Recovery code" />);
    const input = screen.getByLabelText('Recovery code');
    expect(input.tagName).toBe('INPUT');
  });

  it('wires aria-describedby to the description and error text', () => {
    render(<Input label="Recovery code" description="6 digits" error="That code is not valid." />);
    const input = screen.getByLabelText('Recovery code');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const ids = describedBy.split(' ');
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('does not set aria-invalid when there is no error', () => {
    render(<Input label="Recovery code" />);
    const input = screen.getByLabelText('Recovery code');
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('renders a leadingIcon slot', () => {
    render(
      <Input label="Search" leadingIcon={<Search data-testid="leading-icon" aria-hidden />} />,
    );
    screen.getByTestId('leading-icon');
  });

  it('renders a trailingAddon slot', () => {
    render(<Input label="Amount" trailingAddon={<span data-testid="addon">INR</span>} />);
    screen.getByTestId('addon');
  });

  it('shows a required asterisk with a screen-reader label when requiredLabel is set', () => {
    render(<Input label="Recovery code" required requiredLabel="required" />);
    screen.getByText('required');
  });

  it('supports sm and md sizes', () => {
    render(<Input label="A" size="sm" data-testid="a" />);
    render(<Input label="B" size="md" data-testid="b" />);
    expect(screen.getByTestId('a').className).toMatch(/h-8/);
    expect(screen.getByTestId('b').className).toMatch(/h-9/);
  });

  it('forwards ref to the underlying input element', () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<Input label="Recovery code" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('accepts user input and forwards onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input label="Recovery code" onChange={onChange} />);
    const input = screen.getByLabelText('Recovery code');
    await user.type(input, 'abc');
    expect(onChange).toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('abc');
  });

  it('merges className', () => {
    render(<Input label="Recovery code" className="extra-class" data-testid="input" />);
    expect(screen.getByTestId('input').classList.contains('extra-class')).toBe(true);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Input label="Recovery code" error="That recovery code is not valid." />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
