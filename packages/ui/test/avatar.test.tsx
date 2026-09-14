// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { Avatar } from '../src/avatar.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Avatar', () => {
  afterEach(() => {
    cleanup();
  });

  it('derives max-2-letter initials from a name', () => {
    render(<Avatar name="Priya Sharma" />);
    expect(screen.getByText('PS')).toBeTruthy();
  });

  it('derives a single-letter initial from a one-word name', () => {
    render(<Avatar name="Priya" />);
    expect(screen.getByText('P')).toBeTruthy();
  });

  it('is Devanagari-safe (uses Array.from, never slices UTF-16 code units)', () => {
    render(<Avatar name="प्रिया शर्मा" />);
    const fallback = screen.getByTestId('avatar-fallback');
    // Array.from over grapheme-adjacent code points keeps each initial intact
    // (no split surrogate/combining-mark halves) and caps at 2 initials.
    expect(Array.from(fallback.textContent ?? '').length).toBeLessThanOrEqual(2);
    expect(fallback.textContent).toBeTruthy();
  });

  it('renders an accessible name from the name prop', () => {
    render(<Avatar name="Priya Sharma" />);
    expect(screen.getByRole('img', { name: 'Priya Sharma' })).toBeTruthy();
  });

  it('supports sm md lg sizes', () => {
    const { rerender } = render(<Avatar name="Priya Sharma" size="sm" />);
    expect(screen.getByRole('img').className).toContain('h-8');
    rerender(<Avatar name="Priya Sharma" size="md" />);
    expect(screen.getByRole('img').className).toContain('h-10');
    rerender(<Avatar name="Priya Sharma" size="lg" />);
    expect(screen.getByRole('img').className).toContain('h-12');
  });

  it('supports circle and square shapes', () => {
    const { rerender } = render(<Avatar name="Priya Sharma" shape="circle" />);
    expect(screen.getByRole('img').className).toContain('rounded-full');
    rerender(<Avatar name="Priya Sharma" shape="square" />);
    expect(screen.getByRole('img').className).toContain('rounded-md');
  });

  it('derives a deterministic tint class from the name', () => {
    render(<Avatar name="Priya Sharma" />);
    const fallback = screen.getByTestId('avatar-fallback');
    expect(fallback.className).toMatch(/bg-chart-[1-5]\/\d+|bg-chart-[1-5]-soft/);
  });

  it('the same name always maps to the same tint', () => {
    const { unmount } = render(<Avatar name="Priya Sharma" />);
    const first = screen.getByTestId('avatar-fallback').className;
    unmount();
    render(<Avatar name="Priya Sharma" />);
    const second = screen.getByTestId('avatar-fallback').className;
    expect(first).toBe(second);
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Avatar name="Priya Sharma" />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
