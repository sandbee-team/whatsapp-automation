'use client';

import * as React from 'react';
import { Select as BaseSelect } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from './lib/cx.js';

/**
 * Select - built on Base UI's Select (ADR 0007). Renders a real `<button>`
 * trigger wired to the field label via `aria-labelledby`, a chevron icon,
 * and a popup styled per the brief (`data-[starting-style]` fade/scale).
 * `error` sets `aria-invalid` on the trigger. Carries `'use client'`: uses
 * Base UI's controlled `open`/`value` state internally.
 */
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export type SelectSize = 'sm' | 'md';

export interface SelectProps {
  label: string;
  description?: string;
  error?: string;
  placeholder: string;
  options: SelectOption[];
  value: string | null;
  onValueChange: (value: string, eventDetails: unknown) => void;
  disabled?: boolean;
  name?: string;
  size?: SelectSize;
  className?: string;
}

const SIZE_CLASSES: Record<SelectSize, string> = {
  sm: 'h-8 text-sm',
  md: 'h-9 text-sm',
};

export function Select({
  label,
  description,
  error,
  placeholder,
  options,
  value,
  onValueChange,
  disabled,
  name,
  size = 'md',
  className,
}: SelectProps): React.JSX.Element {
  const labelId = React.useId();
  const descriptionId = React.useId();
  const errorId = React.useId();
  const describedBy =
    [description ? descriptionId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <div className="flex flex-col gap-1">
      <span id={labelId} className="text-sm font-medium font-ui text-fg">
        {label}
      </span>
      <BaseSelect.Root
        items={options}
        value={value}
        onValueChange={(nextValue, eventDetails) => {
          if (nextValue !== null) onValueChange(nextValue, eventDetails);
        }}
        disabled={disabled}
        name={name}
      >
        <BaseSelect.Trigger
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error) || undefined}
          className={cx(
            'flex w-full items-center justify-between gap-2 rounded-md border',
            'border-border-strong bg-surface px-3 font-ui text-fg',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 ring-offset-bg disabled:opacity-50',
            'disabled:pointer-events-none',
            SIZE_CLASSES[size],
            error && 'border-danger',
            className,
          )}
        >
          <BaseSelect.Value placeholder={placeholder} className="truncate text-left" />
          <BaseSelect.Icon className="text-subtle">
            <ChevronDown aria-hidden size={16} />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner className="z-50" sideOffset={4}>
            <BaseSelect.Popup
              className={cx(
                'max-h-64 min-w-[var(--anchor-width)] overflow-y-auto rounded-md border',
                'border-border bg-surface p-1 shadow-md font-ui text-fg',
                'data-[starting-style]:opacity-0 data-[starting-style]:scale-95',
                'data-[ending-style]:opacity-0 transition-[opacity,transform] duration-150',
              )}
            >
              <BaseSelect.List>
                {options.map((option) => (
                  <BaseSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={cx(
                      'flex cursor-default select-none items-center justify-between gap-2',
                      'rounded-sm px-2 py-1.5 text-sm',
                      'data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50',
                      'data-[disabled]:pointer-events-none',
                    )}
                  >
                    <span className="flex flex-col">
                      <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                      {option.description ? (
                        <span className="text-xs text-muted">{option.description}</span>
                      ) : null}
                    </span>
                    <BaseSelect.ItemIndicator>
                      <Check aria-hidden size={16} />
                    </BaseSelect.ItemIndicator>
                  </BaseSelect.Item>
                ))}
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
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
}
