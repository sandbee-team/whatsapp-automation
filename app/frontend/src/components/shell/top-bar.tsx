import * as React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import { IconButton, Kbd, useT } from '@wp/ui';
import { NotificationBell } from '../../features/notifications/index.js';
import { NAV_GROUPS } from './nav-config.js';
import { UserMenu } from './user-menu.js';
import { LocaleMenu } from './locale-menu.js';
import { ThemeMenu } from './theme-menu.js';
import type { MeOutput } from '../../features/auth/index.js';

/**
 * TopBar (P26b U2, design brief section 3) - `h-14` sticky bar: hamburger
 * (mobile only) + breadcrumb label from the current path via `NAV_GROUPS`
 * lookup; command palette trigger (`lg` only, shows a `Ctrl K` `Kbd` hint);
 * `extra` slot (U3 mounts the instance switcher there); bell, locale switch,
 * user menu.
 */
export interface TopBarProps {
  me: MeOutput;
  onOpenMobileNav: () => void;
  onOpenCommandPalette: () => void;
  extra?: React.ReactNode;
}

function breadcrumbLabelForPath(pathname: string, t: (key: never) => string): string | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.to === pathname) {
        return t(item.labelKey as never);
      }
    }
  }
  return null;
}

export function TopBar({
  me,
  onOpenMobileNav,
  onOpenCommandPalette,
  extra,
}: TopBarProps): React.JSX.Element {
  const t = useT();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const breadcrumb = breadcrumbLabelForPath(pathname, t);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <IconButton
          aria-label={t('shell.topBar.openNav')}
          className="lg:hidden"
          onClick={onOpenMobileNav}
        >
          <Menu aria-hidden size={18} />
        </IconButton>
        {breadcrumb ? (
          <span className="truncate text-sm font-medium font-ui text-fg">{breadcrumb}</span>
        ) : null}
      </div>

      <div className="hidden flex-1 justify-center lg:flex">
        <button
          type="button"
          data-testid="command-palette-trigger"
          onClick={onOpenCommandPalette}
          className="flex h-9 w-full max-w-sm items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-sm text-subtle hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg"
        >
          <Search aria-hidden size={16} />
          <span className="flex-1 text-left">{t('shell.commandPalette.placeholder')}</span>
          <Kbd>Ctrl K</Kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {extra}
        <NotificationBell />
        <ThemeMenu />
        <LocaleMenu />
        <span aria-hidden="true" className="mx-1 h-6 w-px bg-border" />
        <UserMenu me={me} />
      </div>
    </header>
  );
}
