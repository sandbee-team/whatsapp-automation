'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input, type InputProps } from './input.js';

/**
 * PasswordInput - `Input` with a show/hide toggle in the trailing addon
 * slot. The toggle is a real button with `aria-pressed` reflecting the
 * current visibility state; `showLabel`/`hideLabel` are the caller-supplied
 * accessible names for the two states (no hard-coded copy in this package).
 * Carries `'use client'`: uses `useState` for the visibility toggle.
 */
export interface PasswordInputProps extends Omit<InputProps, 'type' | 'trailingAddon'> {
  /** Accessible name for the toggle button while the password is hidden. */
  showLabel: string;
  /** Accessible name for the toggle button while the password is shown. */
  hideLabel: string;
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ showLabel, hideLabel, ...rest }, ref) {
    const [visible, setVisible] = React.useState(false);

    return (
      <Input
        ref={ref}
        type={visible ? 'text' : 'password'}
        trailingAddon={
          <button
            type="button"
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
            className="pointer-events-auto inline-flex items-center justify-center rounded-sm p-1 text-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {visible ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
            <span className="sr-only">{visible ? hideLabel : showLabel}</span>
          </button>
        }
        {...rest}
      />
    );
  },
);
