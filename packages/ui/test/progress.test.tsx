// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Progress } from '../src/progress.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Progress', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the label and value text', () => {
    render(<Progress value={40} label="Import progress" valueText="40 of 100" />);
    screen.getByText('Import progress');
    screen.getByText('40 of 100');
  });

  it('sets aria-valuenow via the progressbar role', () => {
    render(<Progress value={40} max={100} label="Import progress" valueText="40%" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('supports an indeterminate state (value=null)', () => {
    render(<Progress value={null} label="Loading" valueText="Loading" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Progress value={40} label="Import progress" valueText="40%" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
