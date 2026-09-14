// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Skeleton, SkeletonText, SkeletonRows } from '../src/skeleton.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Skeleton', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders an aria-hidden block with a shimmer overlay', () => {
    render(<Skeleton data-testid="block" />);
    const block = screen.getByTestId('block');
    expect(block.getAttribute('aria-hidden')).toBe('true');
    expect(block.className).toContain('relative');
    expect(block.className).toContain('overflow-hidden');
    expect(block.className).toContain('bg-surface-2');
    expect(block.className).toContain('rounded');
    expect(block.className).toContain('after:animate-shimmer');
    expect(block.className).toContain('motion-reduce:after:animate-none');
  });

  it('SkeletonText renders the requested number of lines', () => {
    render(<SkeletonText lines={3} data-testid="text" />);
    const container = screen.getByTestId('text');
    expect(container.children.length).toBe(3);
  });

  it('SkeletonText defaults to one line', () => {
    render(<SkeletonText data-testid="text" />);
    expect(screen.getByTestId('text').children.length).toBe(1);
  });

  it('SkeletonRows renders rows x columns cells', () => {
    render(<SkeletonRows rows={2} columns={4} data-testid="rows" />);
    const container = screen.getByTestId('rows');
    expect(container.children.length).toBe(2);
    expect(container.children[0]?.children.length).toBe(4);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <div>
        <Skeleton />
        <SkeletonText lines={2} />
        <SkeletonRows rows={2} columns={3} />
      </div>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
