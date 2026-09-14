// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { StatusDot } from '../src/status-dot.js';

/** Mirrors `test/a11y.test.tsx`'s AXE_OPTIONS (contrast needs real layout). */
const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('StatusDot', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a visually-hidden label by default (never colour-only)', () => {
    render(<StatusDot tone="success" label="Live" />);
    const label = screen.getByText('Live');
    expect(label.className).toContain('sr-only');
  });

  it('renders a visible label when hideLabel is false', () => {
    render(<StatusDot tone="danger" label="Offline" hideLabel={false} />);
    const label = screen.getByText('Offline');
    expect(label.className).not.toContain('sr-only');
  });

  it('applies the tone class for each tone', () => {
    const { container } = render(<StatusDot tone="warning" label="Degraded" />);
    const dot = container.querySelector('[data-testid="status-dot-indicator"]');
    expect(dot?.className).toContain('bg-warning');
  });

  it('adds a pulse animation class when pulse is set', () => {
    const { container } = render(<StatusDot tone="success" label="Live" pulse />);
    const dot = container.querySelector('[data-testid="status-dot-indicator"]');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('passes through className to the root element', () => {
    render(<StatusDot tone="info" label="Syncing" className="ml-2" data-testid="root" />);
    expect(screen.getByTestId('root').className).toContain('ml-2');
  });

  it('has zero axe violations', async () => {
    const { container } = render(<StatusDot tone="success" label="Live" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
