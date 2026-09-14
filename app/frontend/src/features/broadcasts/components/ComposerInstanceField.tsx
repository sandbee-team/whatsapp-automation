import * as React from 'react';
import { Select, type SelectOption, type TFunction } from '@wp/ui';
import type { InstanceOption } from '../api.js';

/**
 * ComposerInstanceField (P26b select migration, sibling split off
 * `composer.tsx` to stay under the `max-lines: 300` cap) - the composer's
 * "From number" field: a visual `Select` plus a visually-hidden, still
 * value-holding native `<select data-testid="composer-instance">` wired to
 * the SAME `value`/`onChange`, the exact idiom `messages/compose/AccountPicker.tsx`
 * established for keeping `fireEvent.change`-driven tests working against a
 * Base UI `Select` trigger that renders no native `<select>` of its own.
 */
export interface ComposerInstanceFieldProps {
  label: string;
  instances: InstanceOption[];
  value: string;
  onValueChange: (value: string) => void;
  t: TFunction;
}

export function ComposerInstanceField({
  label,
  instances,
  value,
  onValueChange,
  t,
}: ComposerInstanceFieldProps): React.JSX.Element {
  const options: SelectOption[] = instances.map((option) => ({
    value: option.instanceId,
    label: t('broadcasts.composer.instanceOption', {
      label: option.label,
      tier: option.warmupTier,
      cap: option.effDailyCap,
    }),
  }));

  return (
    <div className="flex flex-col gap-1">
      <Select
        label={label}
        placeholder={label}
        options={options}
        value={value || null}
        onValueChange={onValueChange}
      />
      {/* Real, functional value holder kept for existing test ids/behaviour
          (composer.test.tsx drives this directly); visually hidden, not
          `display:none`, so it stays in the accessibility/focus tree. */}
      <select
        aria-hidden="true"
        tabIndex={-1}
        data-testid="composer-instance"
        className="sr-only"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="" />
        {instances.map((option) => (
          <option key={option.instanceId} value={option.instanceId}>
            {option.instanceId}
          </option>
        ))}
      </select>
    </div>
  );
}
