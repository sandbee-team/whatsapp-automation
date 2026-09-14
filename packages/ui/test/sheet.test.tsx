// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Sheet } from '../src/sheet.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Sheet', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps the backward-compatible API: title/description/children/closeLabel', () => {
    render(
      <Sheet
        open
        onOpenChange={() => {}}
        title="Account recovery"
        description="Enter a code."
        closeLabel="Close"
      >
        <p>Body content</p>
      </Sheet>,
    );
    screen.getByText('Account recovery');
    screen.getByText('Enter a code.');
    screen.getByText('Body content');
    screen.getByRole('button', { name: 'Close' });
  });

  it('defaults to side="right"', () => {
    render(
      <Sheet open onOpenChange={() => {}} title="Title" closeLabel="Close">
        <p>Body</p>
      </Sheet>,
    );
    const popup = screen.getByRole('dialog');
    expect(popup.className).toMatch(/right-0/);
  });

  it('side="left" renders on the left edge', () => {
    render(
      <Sheet open onOpenChange={() => {}} title="Title" closeLabel="Close" side="left">
        <p>Body</p>
      </Sheet>,
    );
    const popup = screen.getByRole('dialog');
    expect(popup.className).toMatch(/left-0/);
  });

  it('side="bottom" renders at the bottom edge', () => {
    render(
      <Sheet open onOpenChange={() => {}} title="Title" closeLabel="Close" side="bottom">
        <p>Body</p>
      </Sheet>,
    );
    const popup = screen.getByRole('dialog');
    expect(popup.className).toMatch(/bottom-0/);
  });

  it('renders the footer slot', () => {
    render(
      <Sheet
        open
        onOpenChange={() => {}}
        title="Title"
        closeLabel="Close"
        footer={<button type="button">Save changes</button>}
      >
        <p>Body</p>
      </Sheet>,
    );
    screen.getByRole('button', { name: 'Save changes' });
  });

  it('Escape calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange} title="Title" closeLabel="Close">
        <p>Body</p>
      </Sheet>,
    );
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Sheet
        open
        onOpenChange={() => {}}
        title="Account recovery"
        description="Enter a code."
        closeLabel="Close"
      >
        <p>Body content</p>
      </Sheet>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
