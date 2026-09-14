// @vitest-environment jsdom
import * as React from 'react';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { clampPercent, arcPath } from '../src/charts/chart-support.js';
import { ProgressRing } from '../src/charts/progress-ring.js';
import { DonutChart } from '../src/charts/donut-chart.js';
import { BarList } from '../src/charts/bar-list.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

afterEach(() => {
  cleanup();
});

describe('clampPercent', () => {
  it('clamps below zero to zero', () => {
    expect(clampPercent(-10)).toBe(0);
  });

  it('clamps above max to max', () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(150, 50)).toBe(50);
  });

  it('passes through an in-range value', () => {
    expect(clampPercent(42)).toBe(42);
  });

  it('treats non-finite input as zero', () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('arcPath', () => {
  it('builds an exact quarter-circle arc path', () => {
    expect(arcPath(50, 50, 40, 0, 90)).toBe('M 50 10 A 40 40 0 0 1 90 50');
  });

  it('sets the large-arc flag for spans over 180deg', () => {
    expect(arcPath(50, 50, 40, 0, 270)).toBe('M 50 10 A 40 40 0 1 1 10 50.00000000000001');
  });

  it('returns an empty string for a zero-length arc', () => {
    expect(arcPath(50, 50, 40, 20, 20)).toBe('');
  });
});

describe('ProgressRing', () => {
  it('renders an accessible role=img with the given label', () => {
    render(<ProgressRing value={50} label="Fleet health 50 of 100" />);
    expect(screen.getByRole('img', { name: 'Fleet health 50 of 100' })).toBeTruthy();
  });

  it('sets the exact final dashoffset for value=25', () => {
    render(<ProgressRing value={25} label="25 percent" />);
    const arc = screen.getByTestId('progress-ring-arc');
    const radius = 96 / 2 - 8 / 2;
    const circumference = 2 * Math.PI * radius;
    const expected = circumference * (1 - 25 / 100);
    expect(arc.getAttribute('stroke-dashoffset')).toBe(String(expected));
  });

  it('sets the exact final dashoffset for value=50', () => {
    render(<ProgressRing value={50} label="50 percent" />);
    const arc = screen.getByTestId('progress-ring-arc');
    const radius = 96 / 2 - 8 / 2;
    const circumference = 2 * Math.PI * radius;
    const expected = circumference * (1 - 50 / 100);
    expect(arc.getAttribute('stroke-dashoffset')).toBe(String(expected));
  });

  it('sets the exact final dashoffset for value=100 (fully drawn, dashoffset zero)', () => {
    render(<ProgressRing value={100} label="100 percent" />);
    const arc = screen.getByTestId('progress-ring-arc');
    expect(arc.getAttribute('stroke-dashoffset')).toBe('0');
  });

  it('renders centre content when provided', () => {
    render(
      <ProgressRing value={75} label="75 percent">
        <span>75</span>
      </ProgressRing>,
    );
    expect(screen.getByText('75')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<ProgressRing value={60} label="Fleet health" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});

describe('DonutChart', () => {
  const segments = [
    { id: 'sent', label: 'Sent', value: 60, tone: 'success' as const },
    { id: 'failed', label: 'Failed', value: 15, tone: 'danger' as const },
    { id: 'waiting', label: 'Waiting', value: 25, tone: 'info' as const },
  ];

  it('renders an accessible role=img with the given label', () => {
    render(<DonutChart segments={segments} label="Today's outcomes" />);
    expect(screen.getByRole('img', { name: "Today's outcomes" })).toBeTruthy();
  });

  it('renders a legend item per segment with its value and percentage', () => {
    render(<DonutChart segments={segments} label="Today's outcomes" />);
    const legend = screen.getByRole('list');
    const items = within(legend).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('Sent')).toBeTruthy();
    expect(within(items[0]).getByText(/60/)).toBeTruthy();
    expect(within(items[0]).getByText(/60%/)).toBeTruthy();
    expect(within(items[1]).getByText(/15%/)).toBeTruthy();
    expect(within(items[2]).getByText(/25%/)).toBeTruthy();
  });

  it('can hide the legend', () => {
    render(<DonutChart segments={segments} label="Today's outcomes" legend={false} />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('draws only the track when every value is zero', () => {
    const zeroSegments = [
      { id: 'sent', label: 'Sent', value: 0, tone: 'success' as const },
      { id: 'failed', label: 'Failed', value: 0, tone: 'danger' as const },
    ];
    render(<DonutChart segments={zeroSegments} label="Nothing yet" />);
    expect(screen.queryAllByTestId('donut-chart-segment')).toHaveLength(0);
    expect(screen.getByTestId('donut-chart-track')).toBeTruthy();
  });

  it('renders centre content', () => {
    render(
      <DonutChart
        segments={segments}
        label="Today's outcomes"
        centre={<span>100 messages</span>}
      />,
    );
    expect(screen.getByText('100 messages')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<DonutChart segments={segments} label="Today's outcomes" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});

describe('BarList', () => {
  const rows = [
    { id: '1', label: 'Number one', value: 40, max: 100, tone: 'success' as const },
    { id: '2', label: 'Number two', value: 150, max: 100, tone: 'warning' as const },
    {
      id: '3',
      label: 'Number three',
      value: 10,
      max: 50,
      tone: 'info' as const,
      href: '/instances/3',
    },
  ];

  it('renders a role=list with a role=listitem per row', () => {
    render(<BarList rows={rows} />);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('clamps a bar width to 100% when value exceeds max', () => {
    render(<BarList rows={rows} />);
    const bars = screen.getAllByRole('progressbar');
    expect(bars[1].style.width).toBe('100%');
    expect(bars[1].getAttribute('aria-valuenow')).toBe('150');
    expect(bars[1].getAttribute('aria-valuemin')).toBe('0');
    expect(bars[1].getAttribute('aria-valuemax')).toBe('100');
    expect(bars[1].getAttribute('aria-label')).toBe('Number two');
  });

  it('renders a row with href as a link', () => {
    render(<BarList rows={rows} />);
    const link = screen.getByRole('link', { name: /Number three/ });
    expect(link.getAttribute('href')).toBe('/instances/3');
  });

  it('renders the empty message when rows is empty', () => {
    render(<BarList rows={[]} emptyMessage="No numbers yet" />);
    expect(screen.getByText('No numbers yet')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<BarList rows={rows} />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
