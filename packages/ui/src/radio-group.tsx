'use client';

import * as React from 'react';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Radio } from '@base-ui/react/radio';
import { cx } from './lib/cx.js';

/**
 * RadioGroup - built on Base UI's `RadioGroup` + `Radio.Root`/`Indicator`
 * (ADR 0007). The group is labelled via `aria-labelledby` pointing at a
 * sibling `<span>` (the documented pattern, since `RadioGroup` renders a
 * `<div>` with no native fieldset/legend). `orientation` toggles a
 * horizontal/vertical flex layout. Carries `'use client'`: uses Base UI's
 * controlled `value` state internally.
 */
export interface RadioGroupOption {
  value: string;
  label: string;
  description?: string;
}

export type RadioGroupOrientation = 'horizontal' | 'vertical';

export interface RadioGroupProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseRadioGroup>,
  'children' | 'value' | 'onValueChange' | 'className'
> {
  label: string;
  options: RadioGroupOption[];
  value: string | null;
  onValueChange: (value: string, eventDetails: unknown) => void;
  orientation?: RadioGroupOrientation;
  className?: string;
}

export function RadioGroup({
  label,
  options,
  value,
  onValueChange,
  orientation = 'vertical',
  className,
  ...rest
}: RadioGroupProps): React.JSX.Element {
  const labelId = React.useId();

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="text-sm font-medium font-ui text-fg">
        {label}
      </span>
      <BaseRadioGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={(nextValue, eventDetails) => {
          onValueChange(nextValue as string, eventDetails);
        }}
        className={cx(
          'flex gap-3',
          orientation === 'horizontal' ? 'flex-row flex-wrap' : 'flex-col',
          className,
        )}
        {...rest}
      >
        {options.map((option) => {
          const optionId = `${labelId}-${option.value}`;
          const descriptionId = option.description ? `${optionId}-description` : undefined;
          return (
            <label key={option.value} htmlFor={optionId} className="flex items-start gap-2">
              <Radio.Root
                id={optionId}
                value={option.value}
                aria-describedby={descriptionId}
                className={cx(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                  'border border-border-strong bg-surface data-[checked]:border-accent',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  'focus-visible:ring-offset-2 ring-offset-bg data-[disabled]:opacity-50',
                  'data-[disabled]:pointer-events-none',
                )}
              >
                <Radio.Indicator className="h-2 w-2 rounded-full bg-accent data-[unchecked]:hidden" />
              </Radio.Root>
              <span className="flex flex-col text-sm font-ui text-fg">
                {option.label}
                {option.description ? (
                  <span id={descriptionId} className="text-sm text-muted">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </BaseRadioGroup>
    </div>
  );
}
