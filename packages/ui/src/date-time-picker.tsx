'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { Input } from './input.js';

/**
 * DateTimePicker - wraps a native `<input type="datetime-local">` via
 * `Input`'s anatomy (label/description/error/aria-invalid), converting
 * between the input's local `YYYY-MM-DDTHH:mm` string and an ISO 8601
 * string. No calendar library (design brief: "no calendar library"). The
 * optional clear button (via `Input`'s `trailingAddon`) resets the value to
 * `null`; its accessible label comes from `clearLabel` (no hard-coded copy).
 */
export interface DateTimePickerProps {
  label: string;
  description?: string;
  error?: string;
  /** ISO 8601 string, or null when empty. */
  value: string | null;
  onValueChange: (iso: string | null) => void;
  min?: string;
  /** Optional caption naming the timezone the picker operates in (e.g. "IST"). */
  timezoneLabel?: string;
  /** Accessible label for the clear button; button renders only when supplied. */
  clearLabel?: string;
  disabled?: boolean;
}

/** Pads local Date fields into the `datetime-local` input's expected string. */
function toLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function fromLocalInputValue(localValue: string): string | null {
  if (!localValue) return null;
  const date = new Date(localValue);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function DateTimePicker({
  label,
  description,
  error,
  value,
  onValueChange,
  min,
  timezoneLabel,
  clearLabel,
  disabled,
}: DateTimePickerProps): React.JSX.Element {
  const localValue = toLocalInputValue(value);
  const combinedDescription = timezoneLabel
    ? [description, timezoneLabel].filter(Boolean).join(' · ')
    : description;

  return (
    <Input
      type="datetime-local"
      label={label}
      description={combinedDescription}
      error={error}
      value={localValue}
      min={min}
      disabled={disabled}
      onChange={(event) => onValueChange(fromLocalInputValue(event.target.value))}
      trailingAddon={
        clearLabel ? (
          <button
            type="button"
            aria-label={clearLabel}
            disabled={disabled}
            onClick={() => onValueChange(null)}
            className="pointer-events-auto flex text-subtle hover:text-fg disabled:opacity-50"
          >
            <X aria-hidden="true" size={16} />
          </button>
        ) : undefined
      }
    />
  );
}
