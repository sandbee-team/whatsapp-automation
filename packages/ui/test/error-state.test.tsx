// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ErrorState } from '../src/error-state.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('ErrorState', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders as a role=status region, not role=alert', () => {
    render(<ErrorState title="Couldn't load connected numbers" />);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders title and body', () => {
    render(
      <ErrorState
        title="Couldn't load connected numbers"
        body="Check your connection and try again."
      />,
    );
    expect(screen.getByText("Couldn't load connected numbers")).toBeTruthy();
    expect(screen.getByText('Check your connection and try again.')).toBeTruthy();
  });

  it('renders a retry action node', () => {
    render(
      <ErrorState
        title="Couldn't load connected numbers"
        retryAction={<button type="button">Retry</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders details in a monospace pre/code block', () => {
    render(<ErrorState title="Couldn't load connected numbers" details="request_id=abc123" />);
    const details = screen.getByText('request_id=abc123');
    expect(details.tagName).toBe('PRE');
    expect(details.className).toContain('font-mono');
    expect(details.className).toContain('text-xs');
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <ErrorState
        title="Couldn't load connected numbers"
        body="Check your connection and try again."
        retryAction={<button type="button">Retry</button>}
        details="request_id=abc123"
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
