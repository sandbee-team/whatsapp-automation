// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { X } from 'lucide-react';
import { IconButton } from '../src/icon-button.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('IconButton', () => {
  afterEach(() => {
    cleanup();
  });

  it('requires an aria-label and exposes it as the accessible name', () => {
    render(
      <IconButton aria-label="Close">
        <X aria-hidden />
      </IconButton>,
    );
    screen.getByRole('button', { name: 'Close' });
  });

  it('renders a square button', () => {
    render(
      <IconButton aria-label="Close" data-testid="icon-button">
        <X aria-hidden />
      </IconButton>,
    );
    const button = screen.getByTestId('icon-button');
    expect(button.className).toMatch(/h-9/);
    expect(button.className).toMatch(/w-9/);
  });

  it('supports sm and lg sizes', () => {
    render(
      <>
        <IconButton aria-label="Close small" size="sm" data-testid="small">
          <X aria-hidden />
        </IconButton>
        <IconButton aria-label="Close large" size="lg" data-testid="large">
          <X aria-hidden />
        </IconButton>
      </>,
    );
    expect(screen.getByTestId('small').className).toMatch(/h-8/);
    expect(screen.getByTestId('large').className).toMatch(/h-10/);
  });

  it('is keyboard activatable and calls onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <IconButton aria-label="Close" onClick={onClick}>
        <X aria-hidden />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Close' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards ref to the underlying button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <IconButton aria-label="Close" ref={ref}>
        <X aria-hidden />
      </IconButton>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <IconButton aria-label="Close">
        <X aria-hidden />
      </IconButton>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
