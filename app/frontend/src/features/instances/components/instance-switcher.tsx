import * as React from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ChevronDown, Phone } from 'lucide-react';
import { Button, DropdownMenu, StatusDot, useT, type DropdownMenuItem } from '@wp/ui';
import { useInstanceList } from '../use-instance-list.js';

/**
 * InstanceSwitcher (P26b U3) - mounted in the top bar's `topBarExtra` slot
 * (`routes/_authed.tsx`). Renders nothing while `useInstanceList` is still
 * loading or when the workspace has zero numbers (no "0 numbers" chrome to
 * confuse an about-to-onboard client). Otherwise a `DropdownMenu` trigger
 * shows the CURRENT number (read from the `/instances/$id` route param when
 * present, else the `instances.switcher.allNumbers` label) with a
 * `StatusDot`; every item navigates to that number's detail route, plus an
 * "All numbers" item back to the list.
 */
export function InstanceSwitcher(): React.JSX.Element | null {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const { items, isLoading } = useInstanceList();

  if (isLoading || items.length === 0) return null;

  const currentInstanceId = 'id' in params ? (params.id as string | undefined) : undefined;
  const current = items.find((item) => item.instanceId === currentInstanceId);
  const triggerLabel = current?.card?.label ?? t('instances.switcher.allNumbers');
  const currentTone = current?.card?.healthState === 'connected' ? 'success' : 'neutral';

  const menuItems: DropdownMenuItem[] = [
    ...items.map((item) => ({
      id: item.instanceId,
      label: item.card?.label ?? item.instanceId,
      icon: <Phone aria-hidden="true" size={16} />,
      onSelect: () => {
        void navigate({ to: '/instances/$id', params: { id: item.instanceId } });
      },
    })),
    { separator: true as const },
    {
      id: 'all-numbers',
      label: t('instances.switcher.allNumbers'),
      onSelect: () => {
        void navigate({ to: '/instances' });
      },
    },
  ];

  return (
    <DropdownMenu
      align="start"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="instance-switcher-trigger"
          aria-label={t('instances.switcher.triggerLabel')}
        >
          <StatusDot tone={currentTone} label={triggerLabel} hideLabel />
          {triggerLabel}
          <ChevronDown aria-hidden="true" size={14} />
        </Button>
      }
      items={menuItems}
    />
  );
}
