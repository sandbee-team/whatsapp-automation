'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';
import type { ButtonVariant } from './button.js';

/**
 * IconButton - a square, icon-only button. `aria-label` is REQUIRED (type-
 * enforced) since the button carries no visible text; tooltip-free by
 * design (the brief keeps tooltips as a separate opt-in primitive owned by
 * U1c). Carries `'use client'`: forwards `onClick`.
 */
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  'aria-label': string;
  variant?: ButtonVariant;
  size?: IconButtonSize;
}

const BASE_CLASSES =
  'inline-flex items-center justify-center rounded-md transition-colors duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 ring-offset-bg active:translate-y-px disabled:opacity-50 ' +
  'disabled:pointer-events-none';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  outline: 'bg-transparent text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg hover:bg-surface-2',
  danger: 'bg-danger text-accent-fg hover:bg-danger-hover',
  link: 'bg-transparent text-accent hover:bg-surface-2',
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', disabled, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cx(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      {...rest}
    >
      {children}
    </button>
  );
});
