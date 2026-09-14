'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * OtpInput - a row of `length` single-character digit cells. Implemented as
 * controlled native `<input>` elements rather than Base UI's `OTPField`:
 * `OTPField.Root`'s invalid/aria-describedby wiring goes through `Field.Root`
 * context (not owned by this unit), so a self-contained implementation keeps
 * the `error` contract simple and fully test-provable (design brief section
 * 4 explicitly allows this fallback). Digits only; paste distributes across
 * the remaining cells; `Backspace` on an empty cell moves focus back a cell
 * and clears it; typing a digit auto-advances.
 */
export interface OtpInputProps {
  length?: number;
  value: string;
  onValueChange: (value: string) => void;
  onComplete?: (value: string) => void;
  label: string;
  error?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}

const DIGITS_ONLY_PATTERN = /\D/g;

export function OtpInput({
  length = 6,
  value,
  onValueChange,
  onComplete,
  label,
  error,
  disabled,
  autoFocus,
  className,
}: OtpInputProps): React.JSX.Element {
  const inputRefs = React.useRef<Array<HTMLInputElement | null>>([]);
  const errorId = React.useId();
  const cells = React.useMemo(
    () => Array.from({ length }, (_, index) => value[index] ?? ''),
    [value, length],
  );

  function commit(nextValue: string) {
    const clamped = nextValue.slice(0, length);
    onValueChange(clamped);
    if (clamped.length === length) {
      onComplete?.(clamped);
    }
  }

  function focusCell(index: number) {
    const target = inputRefs.current[Math.max(0, Math.min(index, length - 1))];
    target?.focus();
    target?.select();
  }

  function handleChange(index: number, rawInput: string) {
    const digits = rawInput.replace(DIGITS_ONLY_PATTERN, '');
    if (digits === '') {
      // A deletion via typing (not Backspace-key path) clears this cell.
      const next = value.slice(0, index) + value.slice(index + 1);
      commit(next);
      return;
    }
    // Distribute every typed/pasted digit starting at this cell.
    const before = value.slice(0, index);
    const after = value.slice(index + digits.length);
    const next = (before + digits + after).slice(0, length);
    commit(next);
    focusCell(index + digits.length);
  }

  function handleKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && cells[index] === '') {
      event.preventDefault();
      const targetIndex = Math.max(0, index - 1);
      const next = value.slice(0, targetIndex) + value.slice(targetIndex + 1);
      commit(next);
      focusCell(targetIndex);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusCell(index - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusCell(index + 1);
    }
  }

  function handlePaste(index: number, event: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text').replace(DIGITS_ONLY_PATTERN, '');
    if (pasted === '') return;
    event.preventDefault();
    const before = value.slice(0, index);
    const next = (before + pasted).slice(0, length);
    commit(next);
    focusCell(next.length - 1);
  }

  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <span className="text-sm font-medium font-ui text-fg" id={`${errorId}-label`}>
        {label}
      </span>
      <div className="flex gap-2" role="group" aria-labelledby={`${errorId}-label`}>
        {cells.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={1}
            value={digit}
            disabled={disabled}
            autoFocus={autoFocus && index === 0}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? `${errorId}-error` : undefined}
            aria-label={`${label} ${String(index + 1)}`}
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={(event) => handlePaste(index, event)}
            className={cx(
              'h-11 w-9 rounded-md border border-border-strong bg-surface text-center font-ui text-lg text-fg',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'focus-visible:ring-offset-2 ring-offset-bg disabled:opacity-50 disabled:pointer-events-none',
              Boolean(error) && 'border-danger',
            )}
          />
        ))}
      </div>
      {error ? (
        <p id={`${errorId}-error`} className="text-sm text-danger font-ui">
          {error}
        </p>
      ) : null}
    </div>
  );
}
