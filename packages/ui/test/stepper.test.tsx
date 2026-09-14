// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Stepper } from '../src/stepper.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

const STEPS = [
  { id: 'connect', label: 'Connect number' },
  { id: 'verify', label: 'Verify' },
  { id: 'send', label: 'Send test message' },
];

describe('Stepper', () => {
  afterEach(() => {
    cleanup();
  });

  it('marks the current step with aria-current="step"', () => {
    render(
      <Stepper
        steps={STEPS}
        current={1}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />,
    );
    const current = screen.getByText('Verify').closest('[aria-current="step"]');
    expect(current).not.toBeNull();
  });

  it('renders hidden state text for done, current and upcoming steps', () => {
    render(
      <Stepper
        steps={STEPS}
        current={1}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />,
    );
    expect(screen.getByText(/Completed/)).toBeTruthy();
    expect(screen.getByText(/Current/)).toBeTruthy();
    expect(screen.getByText(/Upcoming/)).toBeTruthy();
  });

  it('renders a Check icon for completed steps', () => {
    const { container } = render(
      <Stepper
        steps={STEPS}
        current={2}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />,
    );
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('renders vertical orientation with the same step content', () => {
    render(
      <Stepper
        steps={STEPS}
        current={0}
        orientation="vertical"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />,
    );
    expect(screen.getByText('Connect number')).toBeTruthy();
    expect(screen.getByText('Send test message')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Stepper
        steps={STEPS}
        current={1}
        orientation="horizontal"
        completedLabel="Completed"
        currentLabel="Current"
        upcomingLabel="Upcoming"
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
