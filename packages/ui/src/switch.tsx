'use client';

import * as React from 'react';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { cx } from './lib/cx.js';

/**
 * Switch - built on Base UI's Switch (ADR 0007), wrapped in an enclosing
 * `<label>` so `label` is announced as the accessible name. Carries
 * `'use client'`: uses Base UI's controlled `checked` state internally.
 */
export type SwitchSize = 'sm' | 'md';

export interface SwitchProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseSwitch.Root>,
  'children' | 'render' | 'className'
> {
  label: string;
  size?: SwitchSize;
  className?: string;
}

const TRACK_SIZE_CLASSES: Record<SwitchSize, string> = {
  sm: 'h-5 w-9',
  md: 'h-6 w-11',
};

const THUMB_SIZE_CLASSES: Record<SwitchSize, string> = {
  sm: 'h-4 w-4 data-[checked]:translate-x-4',
  md: 'h-5 w-5 data-[checked]:translate-x-5',
};

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { label, size = 'md', className, id, ...rest },
  ref,
) {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;

  return (
    <label htmlFor={switchId} className="flex items-center gap-2">
      <BaseSwitch.Root
        ref={ref}
        id={switchId}
        className={cx(
          'relative inline-flex shrink-0 items-center rounded-full border border-border-strong',
          'bg-surface-2 transition-colors duration-150 data-[checked]:border-accent',
          'data-[checked]:bg-accent focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
          'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
          TRACK_SIZE_CLASSES[size],
          className,
        )}
        {...rest}
      >
        <BaseSwitch.Thumb
          className={cx(
            'block translate-x-0.5 rounded-full bg-surface shadow-sm transition-transform',
            'duration-150',
            THUMB_SIZE_CLASSES[size],
          )}
        />
      </BaseSwitch.Root>
      <span className="text-sm font-ui text-fg">{label}</span>
    </label>
  );
});
