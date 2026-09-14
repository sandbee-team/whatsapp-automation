// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { KpiStat, type KpiStatTone } from '../src/kpi-stat.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('KpiStat', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders label, value and hint', () => {
    render(<KpiStat label="Connected numbers" value="12" hint="of 20 planned" />);
    expect(screen.getByText('Connected numbers')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('of 20 planned')).toBeTruthy();
  });

  it('uses tabular-nums and a large semibold weight for the value', () => {
    render(<KpiStat label="Connected numbers" value="12" />);
    const value = screen.getByText('12');
    expect(value.className).toContain('tabular-nums');
    expect(value.className).toContain('text-3xl');
    expect(value.className).toContain('font-semibold');
  });

  it('shows the delta text alongside a direction arrow, tone by direction', () => {
    render(
      <KpiStat
        label="Messages sent"
        value="1,204"
        delta={{ text: '+12% vs last week', direction: 'up' }}
      />,
    );
    expect(screen.getByText('+12% vs last week')).toBeTruthy();
    const delta = screen.getByTestId('kpi-stat-delta');
    expect(delta.className).toContain('text-success');
  });

  it('renders down direction with a danger tone', () => {
    render(
      <KpiStat label="Failures" value="3" delta={{ text: '-2 vs last week', direction: 'down' }} />,
    );
    expect(screen.getByTestId('kpi-stat-delta').className).toContain('text-danger');
  });

  it('renders flat direction with a muted tone', () => {
    render(<KpiStat label="Failures" value="3" delta={{ text: 'no change', direction: 'flat' }} />);
    expect(screen.getByTestId('kpi-stat-delta').className).toContain('text-muted');
  });

  it('renders an optional icon in a tile', () => {
    render(
      <KpiStat
        label="Connected numbers"
        value="12"
        icon={<svg data-testid="kpi-icon" aria-hidden="true" />}
      />,
    );
    const icon = screen.getByTestId('kpi-icon');
    expect(icon).toBeTruthy();
    const tile = icon.parentElement;
    expect(tile?.className).toContain('rounded-lg');
  });

  it('defaults the icon tile to the accent tone pair', () => {
    render(
      <KpiStat
        label="Connected numbers"
        value="12"
        icon={<svg data-testid="kpi-icon" aria-hidden="true" />}
      />,
    );
    const tile = screen.getByTestId('kpi-icon').parentElement;
    expect(tile?.className).toContain('bg-accent-soft');
    expect(tile?.className).toContain('text-accent');
  });

  it.each<[KpiStatTone, string, string]>([
    ['info', 'bg-info/10', 'text-info'],
    ['success', 'bg-success/10', 'text-success'],
    ['warning', 'bg-warning/10', 'text-warning'],
    ['danger', 'bg-danger/10', 'text-danger'],
  ])('renders the %s tone tile classes', (tone, bgClass, textClass) => {
    render(
      <KpiStat
        label="Spent today"
        value="12"
        tone={tone}
        icon={<svg data-testid="kpi-icon" aria-hidden="true" />}
      />,
    );
    const tile = screen.getByTestId('kpi-icon').parentElement;
    expect(tile?.className).toContain(bgClass);
    expect(tile?.className).toContain(textClass);
  });

  it('renders the animated count-up value when numericValue is supplied', () => {
    const { container } = render(
      <KpiStat label="Connected numbers" value="12" numericValue={12} />,
    );
    const span = container.querySelector('[data-target]');
    expect(span?.getAttribute('data-target')).toBe('12');
  });

  it('renders fixed-height skeleton blocks when loading, with no layout shift', () => {
    render(<KpiStat label="Connected numbers" value="12" loading />);
    expect(screen.queryByText('12')).toBeNull();
    const skeletons = screen.getAllByTestId('kpi-stat-skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <KpiStat
        label="Connected numbers"
        value="12"
        hint="of 20 planned"
        delta={{ text: '+12% vs last week', direction: 'up' }}
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
