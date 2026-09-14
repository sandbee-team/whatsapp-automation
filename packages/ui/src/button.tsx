'use client';

import * as React from 'react';
import { cx } from './lib/cx.js';
import { Spinner } from './spinner.js';

/**
 * Button - variants primary/secondary/outline/ghost/danger/link, sizes
 * sm/md/lg/icon. Carries `'use client'`: it forwards `onClick` and other DOM
 * event props (blueprint: every interactive `@wp/ui` component does).
 * `loading` replaces `leadingIcon` with a `Spinner` and sets `aria-busy`; the
 * caller supplies the spinner's accessible label via `loadingLabel` (no
 * hard-coded copy in this package - `@wp/i18n` is the caller's job).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Accessible label for the loading spinner, shown while `loading` is true. */
  loadingLabel?: string;
  /** Icon rendered before the children; replaced by the spinner while loading. */
  leadingIcon?: React.ReactNode;
  /** Icon rendered after the children. */
  trailingIcon?: React.ReactNode;
}

const BASE_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-md font-ui font-medium ' +
  'transition-[color,background-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg active:translate-y-px ' +
  'disabled:opacity-50 disabled:pointer-events-none';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-sm hover:shadow-md',
  secondary: 'bg-surface text-fg border border-border-strong hover:bg-surface-2',
  outline: 'bg-transparent text-fg border border-border-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg hover:bg-surface-2',
  danger: 'bg-danger text-accent-fg hover:bg-danger-hover',
  link: 'bg-transparent text-accent underline-offset-4 hover:underline p-0 h-auto',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-9 px-4 text-sm',
  lg: 'h-10 px-5 text-base',
  icon: 'h-9 w-9 p-0',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingLabel,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const sizeClasses = variant === 'link' ? '' : SIZE_CLASSES[size];

  return (
    <button
      ref={ref}
      type={type}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cx(BASE_CLASSES, VARIANT_CLASSES[variant], sizeClasses, className)}
      {...rest}
    >
      {loading ? <Spinner size="sm" aria-label={loadingLabel ?? ''} /> : (leadingIcon ?? null)}
      {children}
      {!loading ? (trailingIcon ?? null) : null}
    </button>
  );
});
