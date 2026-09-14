// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { EmptyState } from '../src/empty-state.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('EmptyState', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders title, body and a primary action', () => {
    render(
      <EmptyState
        title="No numbers connected yet"
        body="Connect a number to get started."
        action={<button type="button">Connect a number</button>}
      />,
    );
    expect(screen.getByText('No numbers connected yet')).toBeTruthy();
    expect(screen.getByText('Connect a number to get started.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect a number' })).toBeTruthy();
  });

  it('renders the icon inside a 48px rounded-full ring', () => {
    render(
      <EmptyState
        title="No numbers connected yet"
        icon={<svg data-testid="empty-icon" aria-hidden="true" />}
      />,
    );
    const wrapper = screen.getByTestId('empty-icon').parentElement;
    expect(wrapper?.className).toContain('h-12');
    expect(wrapper?.className).toContain('w-12');
    expect(wrapper?.className).toContain('rounded-full');
    expect(wrapper?.className).toContain('ring-1');
  });

  it('renders an optional secondary action alongside the primary action', () => {
    render(
      <EmptyState
        title="No numbers connected yet"
        action={<button type="button">Connect a number</button>}
        secondaryAction={<button type="button">Learn more</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Connect a number' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Learn more' })).toBeTruthy();
  });

  it('applies a compact layout when compact is set', () => {
    render(<EmptyState title="No results" compact data-testid="empty" />);
    expect(screen.getByTestId('empty').className).toContain('p-6');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <EmptyState
        title="No numbers connected yet"
        body="Connect a number to get started."
        icon={<svg aria-hidden="true" />}
        action={<button type="button">Connect a number</button>}
        secondaryAction={<button type="button">Learn more</button>}
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
