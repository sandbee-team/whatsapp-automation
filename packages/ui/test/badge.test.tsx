// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Badge } from '../src/badge.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Badge', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders children as text content', () => {
    render(<Badge tone="success">Live</Badge>);
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('defaults to the neutral tone with surface-2/muted classes', () => {
    render(<Badge>Draft</Badge>);
    const badge = screen.getByText('Draft');
    expect(badge.className).toContain('bg-surface-2');
    expect(badge.className).toContain('text-muted');
  });

  it('applies soft tint classes for a named tone', () => {
    render(<Badge tone="danger">Failed</Badge>);
    const badge = screen.getByText('Failed');
    expect(badge.className).toContain('danger');
  });

  it('applies accent-soft classes for the accent tone', () => {
    render(<Badge tone="accent">New</Badge>);
    const badge = screen.getByText('New');
    expect(badge.className).toContain('bg-accent-soft');
    expect(badge.className).toContain('text-accent');
  });

  it('supports sm and md sizes', () => {
    const { rerender } = render(<Badge size="sm">Small</Badge>);
    expect(screen.getByText('Small').className).toContain('text-xs');
    rerender(<Badge size="md">Medium</Badge>);
    expect(screen.getByText('Medium').className).toContain('text-sm');
  });

  it('renders a status dot before the text when dot is set, without colour-only signalling', () => {
    render(
      <Badge tone="success" dot>
        Live
      </Badge>,
    );
    expect(screen.getByTestId('status-dot-indicator')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('renders an icon slot before the text when icon is given', () => {
    render(
      <Badge icon={<svg data-testid="badge-icon" aria-hidden="true" />} tone="info">
        Synced
      </Badge>,
    );
    expect(screen.getByTestId('badge-icon')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Badge tone="success" dot>
        Live
      </Badge>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
