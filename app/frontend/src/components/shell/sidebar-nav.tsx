import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cx, useT } from '@wp/ui';
import { NAV_GROUPS } from './nav-config.js';

/**
 * SidebarNav (panel refresh spec section 4, unit S1) - the grouped nav list,
 * split out of `sidebar.tsx` to keep that file under the 300-line cap. Each
 * item is `h-9 rounded-lg px-3 gap-3` with a left active indicator bar
 * (`before:` pseudo-element, visible only when active) rather than a full
 * background swap alone, so active state is never colour-only.
 *
 * Defect A fix (sidebar overflow at 768px-tall viewports): items shrank from
 * `h-10` to `h-9` and the container scrolls internally
 * (`overflow-y-auto` + a themed thin scrollbar) instead of pushing the
 * footer (wallet card, status row) below the fold.
 */
export interface SidebarNavProps {
  currentPath: string;
  isRail: boolean;
}

export function SidebarNav({ currentPath, isRail }: SidebarNavProps): React.JSX.Element {
  const t = useT();

  return (
    <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2 [scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent]">
      {NAV_GROUPS.map((group) => (
        <div key={group.labelKey} className="flex flex-col gap-1">
          {!isRail ? (
            <span className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-sidebar-muted">
              {t(group.labelKey)}
            </span>
          ) : null}
          {group.items.map((item) => {
            const active = currentPath === item.to;
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to as never}
                data-testid={item.testId}
                aria-current={active ? 'page' : undefined}
                title={isRail ? t(item.labelKey) : undefined}
                className={cx(
                  'relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-ui transition-[color,background-color,transform] duration-150',
                  'before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:content-[""]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
                  active
                    ? 'bg-sidebar-active font-medium text-sidebar-active-fg before:bg-accent'
                    : 'text-sidebar-fg before:bg-transparent hover:translate-x-0.5 hover:bg-surface-2',
                )}
              >
                <Icon aria-hidden size={18} className="shrink-0" strokeWidth={1.75} />
                {!isRail ? <span className="truncate">{t(item.labelKey)}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
