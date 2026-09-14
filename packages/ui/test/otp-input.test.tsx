// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { OtpInput } from '../src/otp-input.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function Controlled({
  onComplete,
  error,
}: {
  onComplete?: (value: string) => void;
  error?: string;
}) {
  const [value, setValue] = React.useState('');
  return (
    <OtpInput
      length={6}
      value={value}
      onValueChange={setValue}
      onComplete={onComplete}
      label="Verification code"
      error={error}
    />
  );
}

describe('OtpInput', () => {
  afterEach(() => {
    cleanup();
  });

  it('typing digits fills the cells left to right', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(6);
    await user.type(inputs[0], '123456');
    inputs.forEach((input, index) => {
      expect((input as HTMLInputElement).value).toBe(String(index + 1));
    });
  });

  it('pasting 6 digits fills all cells and calls onComplete', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Controlled onComplete={onComplete} />);
    const inputs = screen.getAllByRole('textbox');
    await user.click(inputs[0]);
    await user.paste('654321');
    inputs.forEach((input, index) => {
      expect((input as HTMLInputElement).value).toBe('654321'[index]);
    });
    expect(onComplete).toHaveBeenCalledWith('654321');
  });

  it('rejects non-digit typed characters: letters/symbols never appear in a cell', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], 'a');
    expect((inputs[0] as HTMLInputElement).value).toBe('');
    await user.type(inputs[0], '!');
    expect((inputs[0] as HTMLInputElement).value).toBe('');
    // A digit typed right after still fills the cell normally - the
    // rejection is per-keystroke, not a stuck/broken cell.
    await user.type(inputs[0], '5');
    expect((inputs[0] as HTMLInputElement).value).toBe('5');
  });

  it('a 7-digit paste keeps only the first 6 digits, never overflowing the cells', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Controlled onComplete={onComplete} />);
    const inputs = screen.getAllByRole('textbox');
    await user.click(inputs[0]);
    await user.paste('1234567');
    inputs.forEach((input, index) => {
      expect((input as HTMLInputElement).value).toBe('123456'[index]);
    });
    expect(onComplete).toHaveBeenCalledWith('123456');
    expect(onComplete).not.toHaveBeenCalledWith('1234567');
  });

  it('a pasted mix of digits and non-digits keeps only the digits, still clamped to 6', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const inputs = screen.getAllByRole('textbox');
    await user.click(inputs[0]);
    await user.paste('12-34-56-78');
    inputs.forEach((input, index) => {
      expect((input as HTMLInputElement).value).toBe('123456'[index]);
    });
  });

  it('Backspace on an empty cell moves focus back a cell', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const inputs = screen.getAllByRole('textbox');
    await user.type(inputs[0], '12');
    expect(document.activeElement).toBe(inputs[2]);
    await user.keyboard('{Backspace}');
    expect(document.activeElement).toBe(inputs[1]);
  });

  it('sets aria-invalid on the cells when error is present', () => {
    render(<Controlled error="That code is not valid." />);
    const inputs = screen.getAllByRole('textbox');
    inputs.forEach((input) => {
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByText('That code is not valid.')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Controlled />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
