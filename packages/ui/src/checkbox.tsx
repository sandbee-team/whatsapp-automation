'use client';

import * as React from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Check } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Checkbox - built on Base UI's Checkbox (ADR 0007), wrapped in an
 * enclosing `<label>` (the simplest labeling pattern per the Base UI docs)
 * so `label` and an optional `description` are both announced. `indeterminate`
 * renders the mixed state. Carries `'use client'`: uses Base UI's controlled
 * `checked` state internally.
 */
export interface CheckboxProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseCheckbox.Root>,
  'children' | 'render' | 'className'
> {
  label: string;
  description?: string;
  className?: string;
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...rest },
  ref,
) {
  const generatedId = React.useId();
  const checkboxId = id ?? generatedId;
  const descriptionId = description ? `${checkboxId}-description` : undefined;

  return (
    <label htmlFor={checkboxId} className="flex items-start gap-2">
      <BaseCheckbox.Root
        ref={ref}
        id={checkboxId}
        aria-describedby={descriptionId}
        className={cx(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border',
          'border-border-strong bg-surface text-accent-fg data-[checked]:border-accent',
          'data-[checked]:bg-accent data-[indeterminate]:border-accent',
          'data-[indeterminate]:bg-accent focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
          'data-[disabled]:opacity-50 data-[disabled]:pointer-events-none',
          className,
        )}
        {...rest}
      >
        <BaseCheckbox.Indicator className="flex" keepMounted={false}>
          <Check aria-hidden size={12} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="flex flex-col text-sm font-ui text-fg">
        {label}
        {description ? (
          <span id={descriptionId} className="text-sm text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
});
