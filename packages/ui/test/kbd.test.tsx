// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Kbd } from '../src/kbd.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Kbd', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a <kbd> element with the given text', () => {
    render(<Kbd>Ctrl K</Kbd>);
    const kbd = screen.getByText('Ctrl K');
    expect(kbd.tagName).toBe('KBD');
  });

  it('forwards className', () => {
    render(<Kbd className="extra-class">Esc</Kbd>);
    const kbd = screen.getByText('Esc');
    expect(kbd.className).toMatch(/extra-class/);
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Kbd>Ctrl K</Kbd>);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
