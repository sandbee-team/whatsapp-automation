// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Tooltip } from '../src/tooltip.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Tooltip', () => {
  afterEach(() => {
    cleanup();
  });

  it('appears on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Pause the queue">
        <button type="button">Pause</button>
      </Tooltip>,
    );
    expect(screen.queryByText('Pause the queue')).toBeNull();
    await user.hover(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => screen.getByText('Pause the queue'));
  });

  it('appears on keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Pause the queue">
        <button type="button">Pause</button>
      </Tooltip>,
    );
    await user.tab();
    await waitFor(() => screen.getByText('Pause the queue'));
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Tooltip content="Pause the queue" delay={0}>
        <button type="button">Pause</button>
      </Tooltip>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
