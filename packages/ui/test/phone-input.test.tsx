// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { PhoneInput } from '../src/phone-input.js';

const AXE_OPTIONS: axe.RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
  rules: { 'color-contrast': { enabled: false } },
};

function Controlled({ initial = '' }: { initial?: string }) {
  const [value, setValue] = React.useState(initial);
  return (
    <PhoneInput
      label="Phone number"
      value={value}
      onValueChange={setValue}
      countryLabel="Country"
    />
  );
}

describe('PhoneInput', () => {
  afterEach(() => {
    cleanup();
  });

  it('defaults the country select to IN and emits E.164 as the national number is typed', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Country' });
    screen.getByText('🇮🇳 +91');
    const numberInput = screen.getByLabelText('Phone number');
    await user.type(numberInput, '9000000000');
    expect((numberInput as HTMLInputElement).value).toContain('9000000000');
    expect(trigger).toBeTruthy();
  });

  it('emits the dial code immediately followed by the national digits', async () => {
    const user = userEvent.setup();
    let latest = '';
    function Harness() {
      const [value, setValue] = React.useState('');
      latest = value;
      return (
        <PhoneInput
          label="Phone number"
          value={value}
          onValueChange={(v) => {
            setValue(v);
            latest = v;
          }}
          countryLabel="Country"
        />
      );
    }
    render(<Harness />);
    const numberInput = screen.getByLabelText('Phone number');
    await user.type(numberInput, '9000000000');
    expect(latest).toBe('+919000000000');
  });

  it('switching the country changes the dial code prefix of the emitted value', async () => {
    const user = userEvent.setup();
    let latest = '';
    function Harness() {
      const [value, setValue] = React.useState('+919000000000');
      return (
        <PhoneInput
          label="Phone number"
          value={value}
          onValueChange={(v) => {
            setValue(v);
            latest = v;
          }}
          countryLabel="Country"
        />
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Country' }));
    const option = await screen.findByRole('option', { name: '🇺🇸 +1' });
    await user.click(option);
    expect(latest.startsWith('+1')).toBe(true);
  });

  it('parses an incoming E.164 value by picking the longest matching dial code', () => {
    render(<Controlled initial="+919000000000" />);
    screen.getByText('🇮🇳 +91');
    const numberInput = screen.getByLabelText('Phone number') as HTMLInputElement;
    expect(numberInput.value).toBe('9000000000');
  });

  it('picks the longest matching dial code when one prefix would otherwise shadow another', () => {
    // A genuinely ambiguous pair: '1' (a hypothetical single-digit code) and
    // '12' (a hypothetical two-digit code sharing that same leading digit).
    // An incoming "+123456789" must resolve to the 2-digit code (longest
    // match), never fall through to the shorter '1' code just because it
    // was checked first / listed first.
    const countries = [
      { iso: 'XA', dial: '1', label: '+1 (short)' },
      { iso: 'XB', dial: '12', label: '+12 (long)' },
    ];
    function Harness() {
      const [value, setValue] = React.useState('+123456789');
      return (
        <PhoneInput
          label="Phone number"
          value={value}
          onValueChange={setValue}
          countryLabel="Country"
          countries={countries}
        />
      );
    }
    render(<Harness />);
    screen.getByText('+12 (long)');
    const numberInput = screen.getByLabelText('Phone number') as HTMLInputElement;
    expect(numberInput.value).toBe('3456789');
  });

  it('renders the error message and sets aria-invalid on the number input', () => {
    render(
      <PhoneInput
        label="Phone number"
        value=""
        onValueChange={vi.fn()}
        countryLabel="Country"
        error="Enter a valid phone number."
      />,
    );
    const numberInput = screen.getByLabelText('Phone number');
    expect(numberInput.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a valid phone number.')).toBeTruthy();
  });

  it('has zero axe violations', async () => {
    const { container } = render(<Controlled />);
    const results = await axe.run(container, AXE_OPTIONS);
    expect(results.violations.length).toBe(0);
  });
});
