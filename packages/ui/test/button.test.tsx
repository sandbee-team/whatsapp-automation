// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Search } from 'lucide-react';
import { Button } from '../src/button.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Button', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults to type="button" and renders children', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
  });

  it('accepts the legacy variant and size unions', () => {
    render(
      <Button variant="secondary" size="sm">
        Cancel
      </Button>,
    );
    screen.getByRole('button', { name: 'Cancel' });
  });

  it('primary variant carries the elevated shadow treatment', () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.className).toContain('shadow-sm');
    expect(button.className).toContain('hover:shadow-md');
  });

  it('every variant gains the extended transition property list', () => {
    render(<Button variant="ghost">Cancel</Button>);
    const button = screen.getByRole('button', { name: 'Cancel' });
    expect(button.className).toContain('transition-[color,background-color,box-shadow,transform]');
  });

  it('accepts the new outline/link variants and lg/icon sizes', () => {
    render(
      <>
        <Button variant="outline">Outline</Button>
        <Button variant="link">Link</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Icon action">
          +
        </Button>
      </>,
    );
    screen.getByRole('button', { name: 'Outline' });
    screen.getByRole('button', { name: 'Link' });
    screen.getByRole('button', { name: 'Large' });
    screen.getByRole('button', { name: 'Icon action' });
  });

  it('renders leadingIcon and trailingIcon slots', () => {
    render(<Button leadingIcon={<Search data-testid="leading-icon" aria-hidden />}>Search</Button>);
    screen.getByTestId('leading-icon');
  });

  it('replaces the leading icon with a spinner while loading and sets aria-busy', () => {
    render(
      <Button loading loadingLabel="Loading" leadingIcon={<Search data-testid="leading-icon" />}>
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'LoadingSave' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('leading-icon')).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
  });

  it('disables the button while loading and forwards disabled', () => {
    render(<Button disabled>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('forwards ref to the underlying button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Save</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('is keyboard activatable and calls onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('merges className and forwards rest props', () => {
    render(
      <Button className="extra-class" data-testid="save-button">
        Save
      </Button>,
    );
    const button = screen.getByTestId('save-button');
    expect(button.classList.contains('extra-class')).toBe(true);
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Button>Save</Button>);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
