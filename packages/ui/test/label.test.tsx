// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Label } from '../src/label.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Label', () => {
  afterEach(() => {
    cleanup();
  });

  it('associates with a control via htmlFor', () => {
    render(
      <>
        <Label htmlFor="field-a">Display name</Label>
        <input id="field-a" />
      </>,
    );
    const input = screen.getByLabelText('Display name');
    expect(input.tagName).toBe('INPUT');
  });

  it('renders an optional hint slot', () => {
    render(
      <Label htmlFor="field-b" hint="Optional">
        Nickname
      </Label>,
    );
    screen.getByText('Optional');
    screen.getByText('Nickname');
  });

  it('forwards ref to the underlying label element', () => {
    const ref = React.createRef<HTMLLabelElement>();
    render(
      <Label htmlFor="field-c" ref={ref}>
        Display name
      </Label>,
    );
    expect(ref.current).toBeInstanceOf(HTMLLabelElement);
  });

  it('merges className', () => {
    render(
      <Label htmlFor="field-d" className="extra-class" data-testid="label">
        Display name
      </Label>,
    );
    expect(screen.getByTestId('label').classList.contains('extra-class')).toBe(true);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <>
        <Label htmlFor="field-e" hint="Optional">
          Nickname
        </Label>
        <input id="field-e" />
      </>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
