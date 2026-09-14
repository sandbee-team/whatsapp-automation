// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Popover } from '../src/popover.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Popover', () => {
  afterEach(() => {
    cleanup();
  });

  it('opens on trigger click and shows title/description', async () => {
    const user = userEvent.setup();
    render(
      <Popover
        trigger={<button type="button">Open filters</button>}
        title="Filters"
        description="Narrow the connected numbers list."
      >
        <p>Body</p>
      </Popover>,
    );
    expect(screen.queryByText('Filters')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open filters' }));
    await waitFor(() => screen.getByText('Filters'));
    screen.getByText('Narrow the connected numbers list.');
  });

  it('Escape closes the popover', async () => {
    const user = userEvent.setup();
    render(
      <Popover trigger={<button type="button">Open</button>}>
        <p>Body</p>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => screen.getByText('Body'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText('Body')).toBeNull());
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Popover trigger={<button type="button">Open</button>} title="Filters">
        <p>Body</p>
      </Popover>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
