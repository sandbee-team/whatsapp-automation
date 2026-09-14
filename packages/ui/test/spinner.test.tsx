// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Spinner } from '../src/spinner.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Spinner', () => {
  afterEach(() => {
    cleanup();
  });

  it('requires an aria-label and exposes role=status', () => {
    render(<Spinner aria-label="Loading" />);
    const spinner = screen.getByRole('status', { name: 'Loading' });
    expect(spinner).toBeTruthy();
  });

  it('supports sm md lg sizes', () => {
    const { rerender } = render(<Spinner aria-label="Loading" size="sm" />);
    expect(screen.getByRole('status').className).toContain('h-4');
    rerender(<Spinner aria-label="Loading" size="md" />);
    expect(screen.getByRole('status').className).toContain('h-5');
    rerender(<Spinner aria-label="Loading" size="lg" />);
    expect(screen.getByRole('status').className).toContain('h-6');
  });

  it('uses a border-t-accent ring', () => {
    render(<Spinner aria-label="Loading" />);
    expect(screen.getByRole('status').className).toContain('border-t-accent');
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Spinner aria-label="Loading" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
