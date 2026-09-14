// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { ScrollArea } from '../src/scroll-area.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('ScrollArea', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders its children inside the scrollable viewport', () => {
    render(
      <ScrollArea>
        <p>Row content</p>
      </ScrollArea>,
    );
    screen.getByText('Row content');
  });

  it('applies a fixed height class when maxHeight is given', () => {
    const { container } = render(
      <ScrollArea maxHeight="20rem">
        <p>Row content</p>
      </ScrollArea>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('style')).toMatch(/20rem/);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <ScrollArea>
        <p>Row content</p>
      </ScrollArea>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
