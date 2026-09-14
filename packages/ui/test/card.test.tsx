// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter } from '../src/card.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Card', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the restyled base classes', () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId('card');
    expect(card.className).toContain('rounded-xl');
    expect(card.className).toContain('border-border');
    expect(card.className).toContain('bg-surface');
    expect(card.className).toContain('shadow-card');
  });

  it('applies interactive hover-lift classes when interactive is set', () => {
    render(
      <Card interactive data-testid="card">
        content
      </Card>,
    );
    const card = screen.getByTestId('card');
    expect(card.className).toContain('hover:-translate-y-0.5');
    expect(card.className).toContain('hover:shadow-md');
    expect(card.className).toContain('transition');
  });

  it('supports the none|sm|md padding variants', () => {
    const { rerender } = render(
      <Card padding="none" data-testid="card">
        content
      </Card>,
    );
    expect(screen.getByTestId('card').className).not.toContain('p-5');
    rerender(
      <Card padding="sm" data-testid="card">
        content
      </Card>,
    );
    expect(screen.getByTestId('card').className).toContain('p-3');
    rerender(
      <Card padding="md" data-testid="card">
        content
      </Card>,
    );
    expect(screen.getByTestId('card').className).toContain('p-5');
  });

  it('renders CardDescription text', () => {
    render(<CardDescription>An overview of connected numbers.</CardDescription>);
    expect(screen.getByText('An overview of connected numbers.')).toBeTruthy();
  });

  it('renders a right-aligned actions slot in CardHeader', async () => {
    const onClick = () => {};
    render(
      <CardHeader actions={<button onClick={onClick}>Manage</button>}>
        <CardTitle>Dashboard</CardTitle>
      </CardHeader>,
    );
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });

  it('renders an eyebrow above the title in CardHeader when supplied', () => {
    render(
      <CardHeader eyebrow="Numbers">
        <CardTitle>Sending today</CardTitle>
      </CardHeader>,
    );
    const eyebrow = screen.getByText('Numbers');
    expect(eyebrow.className).toContain('uppercase');
    expect(eyebrow.className).toContain('text-muted');
  });

  it('CardTitle defaults to text-base', () => {
    render(<CardTitle>Dashboard</CardTitle>);
    expect(screen.getByText('Dashboard').className).toContain('text-base');
  });

  it('interactive card stays keyboard reachable when it wraps a link/button child', async () => {
    const user = userEvent.setup();
    render(
      <Card interactive data-testid="card">
        <button type="button">Open</button>
      </Card>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Card interactive>
        <CardHeader actions={<button type="button">Manage</button>}>
          <CardTitle>Dashboard</CardTitle>
          <CardDescription>An overview.</CardDescription>
        </CardHeader>
        <CardBody>Body content</CardBody>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations).toEqual([]);
  });
});
