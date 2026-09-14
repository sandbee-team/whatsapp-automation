import * as React from 'react';
import { Select, StatusDot, useT, type SelectOption } from '@wp/ui';
import { useInstanceList } from '../../instances/use-instance-list.js';

/**
 * AccountPicker (P26b U4) - the composer's "From number" field. Fed by
 * `useInstanceList()` (the ONE shared instance list - see that hook's own
 * doc comment), rendered as a `Select` with a `StatusDot` per option and
 * numbers that are parked or not yet linked disabled with a hint, never
 * silently omitted (a user must be able to see WHY a number is missing).
 *
 * `composer.test.tsx`/`useComposer.ts` both key off a plain string
 * `instanceId` value and a real `<input data-testid="compose-account-input">`
 * for `fireEvent.change`; this component renders the visual `Select` AND a
 * visually-hidden, still-focusable-by-id input wired to the exact same
 * `value`/`onChange`, so existing tests keep driving the same state setter
 * the `Select` drives, never a second source of truth.
 */
export interface AccountPickerProps {
  value: string;
  onValueChange: (value: string) => void;
}

export function AccountPicker({ value, onValueChange }: AccountPickerProps): React.JSX.Element {
  const t = useT();
  const instanceList = useInstanceList();

  const options: SelectOption[] = instanceList.items.map((item) => {
    const label = item.card?.label ?? item.instanceId;
    const disabled = Boolean(item.card?.parked) || item.card?.linkState !== 'linked';
    return {
      value: item.instanceId,
      label,
      description: disabled ? t('messages.compose.accountPicker.disabledHint') : undefined,
      disabled,
    };
  });

  return (
    <div className="flex flex-col gap-1">
      <Select
        label={t('messages.compose.accountPicker.label')}
        description={t('messages.compose.accountDescription')}
        placeholder={
          options.length === 0
            ? t('messages.compose.accountPicker.empty')
            : t('messages.compose.accountPicker.placeholder')
        }
        options={options}
        value={value || null}
        onValueChange={(next) => onValueChange(next)}
        disabled={options.length === 0}
      />
      {value ? <SelectedAccountStatus instanceId={value} items={instanceList.items} /> : null}
      {/* Real, functional value holder kept for existing test ids/behaviour
          (composer.test.tsx drives this directly); visually hidden, not
          `display:none`, so it stays in the accessibility/focus tree. */}
      <input
        aria-hidden="true"
        tabIndex={-1}
        data-testid="compose-account-input"
        className="sr-only"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
    </div>
  );
}

function SelectedAccountStatus({
  instanceId,
  items,
}: {
  instanceId: string;
  items: ReturnType<typeof useInstanceList>['items'];
}): React.JSX.Element | null {
  const t = useT();
  const selected = items.find((item) => item.instanceId === instanceId);
  if (!selected?.card) return null;

  const tone = selected.card.parked
    ? 'warning'
    : selected.card.linkState === 'linked'
      ? 'success'
      : 'neutral';
  const label = selected.card.parked
    ? t('messages.compose.accountPicker.disabledHint')
    : selected.card.label;

  return <StatusDot tone={tone} label={label} hideLabel={false} className="pl-1" />;
}
