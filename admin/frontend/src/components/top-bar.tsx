import * as React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Check, LogOut, Menu, Monitor, Moon, Sun } from 'lucide-react';
import { Avatar, Badge, DropdownMenu, IconButton, useT, type DropdownMenuItem } from '@wp/ui';
import { NAV_GROUPS } from './nav-config.js';
import { staffLogout, type StaffMeData } from '../features/auth/index.js';
import { setAccessToken } from '../lib/api-client.js';
import { useTheme, type ThemeChoice } from '../providers/theme-provider.js';

/**
 * top-bar.tsx (P28 Unit U6, step 9) - `h-14` sticky bar: breadcrumb (current
 * route's nav label), theme toggle, staff menu (initials -> name, role
 * badge, Log out).
 */
export interface TopBarProps {
  me: StaffMeData;
  onOpenMobileNav: () => void;
}

const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const THEME_TRIGGER_ICON: Record<ThemeChoice, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

function breadcrumbLabelForPath(pathname: string, t: (key: never) => string): string | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.to === pathname) return t(item.labelKey as never);
    }
  }
  return null;
}

export function TopBar({ me, onOpenMobileNav }: TopBarProps): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const breadcrumb = breadcrumbLabelForPath(pathname, t);
  const TriggerIcon = THEME_TRIGGER_ICON[theme];

  const themeItems: DropdownMenuItem[] = THEME_ORDER.map((choice) => ({
    id: `theme-option-${choice}`,
    label: t(`admin.theme.${choice}`),
    icon: theme === choice ? <Check aria-hidden size={16} /> : undefined,
    onSelect: () => setTheme(choice),
  }));

  const onLogout = async (): Promise<void> => {
    try {
      await staffLogout();
    } finally {
      setAccessToken(null);
      queryClient.clear();
      await navigate({ to: '/login' });
    }
  };

  const staffItems: DropdownMenuItem[] = [
    { group: me.fullName },
    { id: 'staff-menu-role', label: me.role, disabled: true, onSelect: () => undefined },
    { separator: true },
    {
      id: 'staff-menu-logout',
      label: t('admin.topBar.logout'),
      icon: <LogOut aria-hidden size={16} />,
      destructive: true,
      onSelect: () => void onLogout(),
    },
  ];

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <IconButton
          aria-label={t('admin.topBar.openNav')}
          className="lg:hidden"
          onClick={onOpenMobileNav}
        >
          <Menu aria-hidden size={18} />
        </IconButton>
        {breadcrumb ? (
          <span className="truncate text-sm font-medium font-ui text-fg">{breadcrumb}</span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <DropdownMenu
          align="end"
          trigger={
            <IconButton data-testid="theme-switch" aria-label={t('admin.theme.label')} size="sm">
              <TriggerIcon aria-hidden size={16} strokeWidth={1.75} />
            </IconButton>
          }
          items={themeItems}
        />
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-border" />
        <DropdownMenu
          align="end"
          trigger={
            <button
              type="button"
              data-testid="staff-menu-trigger"
              aria-label={me.fullName}
              className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
            >
              <Avatar name={me.fullName} size="sm" />
              <Badge tone="neutral" size="sm" className="hidden sm:inline-flex">
                {me.role}
              </Badge>
            </button>
          }
          items={staffItems}
        />
      </div>
    </header>
  );
}
