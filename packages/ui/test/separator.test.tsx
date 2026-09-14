// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Separator } from '../src/separator.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Separator', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a horizontal separator by default', () => {
    render(<Separator data-testid="sep" />);
    const sep = screen.getByTestId('sep');
    expect(sep.getAttribute('aria-orientation')).toBe('horizontal');
    expect(sep.getAttribute('role')).toBe('separator');
    expect(sep.className).toContain('h-px');
  });

  it('renders a vertical separator when requested', () => {
    render(<Separator orientation="vertical" data-testid="sep" />);
    const sep = screen.getByTestId('sep');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.className).toContain('w-px');
  });

  it('renders a centred label when given', () => {
    render(<Separator label="or" />);
    expect(screen.getByText('or')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Separator label="or" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
