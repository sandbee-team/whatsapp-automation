// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { Textarea } from '../src/textarea.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('Textarea', () => {
  afterEach(() => {
    cleanup();
  });

  it('associates the required label via htmlFor/id', () => {
    render(<Textarea label="Message" />);
    const textarea = screen.getByLabelText('Message');
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('wires aria-describedby and aria-invalid from description/error', () => {
    render(<Textarea label="Message" description="Up to 500 chars" error="Message is required." />);
    const textarea = screen.getByLabelText('Message');
    const describedBy = textarea.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
    expect(textarea.getAttribute('aria-invalid')).toBe('true');
  });

  it('accepts a rows prop', () => {
    render(<Textarea label="Message" rows={6} />);
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(6);
  });

  it('renders a maxLength counter via counterLabel', async () => {
    const user = userEvent.setup();
    render(
      <Textarea
        label="Message"
        maxLength={10}
        counterLabel={(count, max) => `${String(count)}/${String(max)}`}
      />,
    );
    screen.getByText('0/10');
    const textarea = screen.getByLabelText('Message');
    await user.type(textarea, 'hi');
    screen.getByText('2/10');
  });

  it('supports auto-resize as an opt-in prop', () => {
    render(<Textarea label="Message" autoResize data-testid="textarea" />);
    screen.getByTestId('textarea');
  });

  it('forwards ref to the underlying textarea element', () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<Textarea label="Message" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('forwards onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Textarea label="Message" onChange={onChange} />);
    await user.type(screen.getByLabelText('Message'), 'hi');
    expect(onChange).toHaveBeenCalled();
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <Textarea
        label="Message"
        error="Message is required."
        maxLength={10}
        counterLabel={(c, m) => `${String(c)}/${String(m)}`}
      />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
