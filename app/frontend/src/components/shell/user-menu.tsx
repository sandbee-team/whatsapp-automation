import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar, DropdownMenu, useT, type DropdownMenuItem } from '@wp/ui';
import { LogOut } from 'lucide-react';
import { logout, type MeOutput } from '../../features/auth/index.js';
import { setAccessToken } from '../../lib/api-client.js';

/**
 * UserMenu (P26b U2) - avatar-initials trigger opening a `DropdownMenu` with
 * name/email/workspace/role (read-only rows) and a Log out action. Grepped
 * `routes/__tests__/authed-guard.test.tsx` and
 * `features/notifications/__tests__/bell.test.tsx` first: neither clicks
 * `logout-button` directly, so it is free to move from the old flat
 * `<button>` (app-shell.tsx) onto the trigger here; tests open the menu via
 * this trigger, then select the "Log out" menu item by its accessible name.
 */
export interface UserMenuProps {
  me: MeOutput;
}

export function UserMenu({ me }: UserMenuProps): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const onLogout = async (): Promise<void> => {
    try {
      await logout();
    } finally {
      setAccessToken(null);
      queryClient.clear();
      await navigate({ to: '/login' });
    }
  };

  const items: DropdownMenuItem[] = [
    { group: me.user.fullName },
    {
      id: 'user-menu-email',
      label: me.user.email,
      disabled: true,
      onSelect: () => undefined,
    },
    {
      id: 'user-menu-workspace',
      label: me.client.companyName,
      disabled: true,
      onSelect: () => undefined,
    },
    {
      id: 'user-menu-role',
      label: me.membership.role,
      disabled: true,
      onSelect: () => undefined,
    },
    { separator: true },
    {
      id: 'user-menu-logout',
      label: t('nav.logout'),
      icon: <LogOut aria-hidden size={16} />,
      destructive: true,
      onSelect: () => void onLogout(),
    },
  ];

  return (
    <DropdownMenu
      align="end"
      trigger={
        <button
          type="button"
          data-testid="logout-button"
          aria-label={t('shell.userMenu.trigger')}
          className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        >
          <Avatar name={me.user.fullName} size="sm" />
        </button>
      }
      items={items}
    />
  );
}
