'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';

/**
 * Input - `label` is a REQUIRED prop, wired via `htmlFor`/`id` (auto
 * `useId()` when no `id` is supplied). `error` sets `aria-invalid` and wires
 * `aria-describedby` to the error text; `description` (help text) is also
 * included in `aria-describedby` when present, so both are announced.
 * `requiredLabel` is the screen-reader text for the asterisk (no hard-coded
 * copy in this package). Carries `'use client'`: forwards `onChange`.
 */
export type InputSize = 'sm' | 'md';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  description?: string;
  error?: string;
  leadingIcon?: React.ReactNode;
  trailingAddon?: React.ReactNode;
  /** Screen-reader text for the required asterisk, shown when `required` is true. */
  requiredLabel?: string;
  size?: InputSize;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'h-8 text-sm',
  md: 'h-9 text-sm',
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    description,
    error,
    leadingIcon,
    trailingAddon,
    required,
    requiredLabel,
    size = 'md',
    id,
    className,
    ...rest
  },
  ref,
) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium font-ui text-fg">
        {label}
        {required ? (
          <>
            <span aria-hidden className="text-danger">
              {' '}
              *
            </span>
            {requiredLabel ? <span className="sr-only">{` ${requiredLabel}`}</span> : null}
          </>
        ) : null}
      </label>
      <div className="relative flex items-center">
        {leadingIcon ? (
          <span aria-hidden className="pointer-events-none absolute left-3 flex text-subtle">
            {leadingIcon}
          </span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          required={required}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          className={cx(
            'w-full rounded-md border border-border-strong bg-surface px-3 font-ui text-fg',
            'placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2',
            'focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
            'disabled:opacity-50 disabled:pointer-events-none',
            SIZE_CLASSES[size],
            Boolean(leadingIcon) && 'pl-9',
            Boolean(trailingAddon) && 'pr-9',
            Boolean(error) && 'border-danger',
            className,
          )}
          {...rest}
        />
        {trailingAddon ? (
          <span className="absolute right-3 flex text-sm text-subtle">{trailingAddon}</span>
        ) : null}
      </div>
      {description ? (
        <p id={descriptionId} className="text-sm text-muted font-ui">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-danger font-ui">
          {error}
        </p>
      ) : null}
    </div>
  );
});
