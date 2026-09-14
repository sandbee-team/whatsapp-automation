// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { DateTimePicker } from '../src/date-time-picker.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

describe('DateTimePicker', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the ISO value converted to a local datetime-local string', () => {
    render(
      <DateTimePicker label="Send at" value="2026-09-07T10:30:00.000Z" onValueChange={vi.fn()} />,
    );
    const input = screen.getByLabelText('Send at') as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).not.toBe('');
  });

  it('renders empty when value is null', () => {
    render(<DateTimePicker label="Send at" value={null} onValueChange={vi.fn()} />);
    const input = screen.getByLabelText('Send at') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('calls onValueChange with an ISO string when the input changes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<DateTimePicker label="Send at" value={null} onValueChange={onValueChange} />);
    const input = screen.getByLabelText('Send at');
    await user.type(input, '2026-09-07T10:30');
    expect(onValueChange).toHaveBeenCalled();
    const lastCall = onValueChange.mock.calls.at(-1)?.[0] as string;
    expect(new Date(lastCall).toISOString()).toBe(lastCall);
  });

  it('shows a clear button that resets the value to null', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DateTimePicker
        label="Send at"
        value="2026-09-07T10:30:00.000Z"
        onValueChange={onValueChange}
        clearLabel="Clear"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it('shows the error message and sets aria-invalid', () => {
    render(
      <DateTimePicker
        label="Send at"
        value={null}
        onValueChange={vi.fn()}
        error="Pick a time in the future."
      />,
    );
    const input = screen.getByLabelText('Send at');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Pick a time in the future.')).toBeTruthy();
  });

  it('round-trips a fixed ISO value through local and back to the identical ISO string', async () => {
    // Deterministic: a fixed input value only, never `Date.now()` or a
    // mocked system clock. The assertion derives the expected round-trip
    // via `new Date(iso)`'s own local getters (the same conversion
    // `DateTimePicker` itself performs) rather than hardcoding a specific
    // timezone's wall-clock string, so it holds on any DST-free zone (the
    // CI host and this repo's dev machine both run IST, which never
    // observes DST).
    const fixedIso = '2026-03-15T09:05:00.000Z';
    const expectedDate = new Date(fixedIso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const expectedLocalValue =
      `${String(expectedDate.getFullYear())}-${pad(expectedDate.getMonth() + 1)}-${pad(expectedDate.getDate())}` +
      `T${pad(expectedDate.getHours())}:${pad(expectedDate.getMinutes())}`;

    const onValueChange = vi.fn();
    function ControlledHarness(): React.JSX.Element {
      const [value, setValue] = React.useState<string | null>(fixedIso);
      return (
        <DateTimePicker
          label="Send at"
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange(next);
          }}
        />
      );
    }
    render(<ControlledHarness />);
    const input = screen.getByLabelText('Send at') as HTMLInputElement;
    // ISO -> local: the rendered input value matches the fixed instant
    // converted through the SAME local-getter conversion the component uses.
    expect(input.value).toBe(expectedLocalValue);

    // local -> ISO: a native `datetime-local` picker commits the full value
    // in one native `change` event (never per-keystroke). Drive the DOM to
    // a different value first (a real `change` event, still through the
    // component - never touching React state directly) so the FOLLOWING
    // change to `expectedLocalValue` is a genuine, non-deduped commit.
    fireEvent.change(input, { target: { value: '2020-01-01T00:00' } });
    fireEvent.change(input, { target: { value: expectedLocalValue } });
    const lastCall = onValueChange.mock.calls.at(-1)?.[0] as string;
    expect(lastCall).toBe(fixedIso);
  });

  it('has zero axe violations', async () => {
    const { container } = render(
      <DateTimePicker label="Send at" value={null} onValueChange={vi.fn()} clearLabel="Clear" />,
    );
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
