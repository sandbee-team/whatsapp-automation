// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Alert } from '../src/alert.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Alert', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders role=status for neutral tone', () => {
    render(<Alert tone="neutral" title="Heads up" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders role=status for the info tone', () => {
    render(<Alert tone="info" title="Heads up" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders role=status for the success tone', () => {
    render(<Alert tone="success" title="Saved" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('renders role=alert for the warning tone', () => {
    render(<Alert tone="warning" title="Careful" />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders role=alert for the danger tone', () => {
    render(<Alert tone="danger" title="Failed" />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders title, body, icon and action', () => {
    render(
      <Alert
        tone="info"
        title="Heads up"
        body="Your safe mode is on."
        icon={<svg data-testid="alert-icon" aria-hidden="true" />}
        action={<button type="button">Review</button>}
      />,
    );
    expect(screen.getByText('Heads up')).toBeTruthy();
    expect(screen.getByText('Your safe mode is on.')).toBeTruthy();
    expect(screen.getByTestId('alert-icon')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('renders a dismiss button only when onDismiss is given, using dismissLabel', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<Alert tone="info" title="Heads up" onDismiss={onDismiss} dismissLabel="Dismiss" />);
    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    await user.click(dismissButton);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders no dismiss button when onDismiss is not given', () => {
    render(<Alert tone="info" title="Heads up" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('has zero axe violations for a dismissible danger alert', async () => {
    const { container } = render(
      <Alert
        tone="danger"
        title="Failed to send"
        body="Try again in a moment."
        onDismiss={() => {}}
        dismissLabel="Dismiss"
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
