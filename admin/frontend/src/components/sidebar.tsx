import * as React from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, ShieldCheck } from 'lucide-react';
import { Badge, cx, useT } from '@wp/ui';
import { NAV_GROUPS } from './nav-config.js';

/**
 * sidebar.tsx (P28 Unit U6, step 9) - `w-64` desktop sidebar, collapsible to
 * a `w-16` icon rail (design brief section 3). Collapse state persists to
 * `localStorage['wp-admin.sidebar']` (try/catch-wrapped). Brand row carries a
 * persistent "STAFF CONSOLE" badge (never omitted, even in rail mode, so the
 * distinct-console signal survives collapse).
 */
const SIDEBAR_STORAGE_KEY = 'wp-admin.sidebar';

export function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeStoredCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Private browsing / disabled storage - the toggle still works for this
    // page load via React state, it just will not persist.
  }
}

export interface SidebarProps {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

export function Sidebar({ collapsed, onCollapsedChange }: SidebarProps): React.JSX.Element {
  const t = useT();
  const currentPath = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg border-r border-sidebar-border">
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"
        >
          <ShieldCheck size={18} strokeWidth={1.75} />
        </span>
        {!collapsed ? (
          <div className="flex min-w-0 flex-col gap-0.5 leading-tight">
            <span className="truncate text-sm font-semibold tracking-tight text-sidebar-fg">
              {t('admin.brand.name')}
            </span>
            <Badge tone="accent" size="sm" data-testid="staff-console-badge">
              {t('admin.brand.badge')}
            </Badge>
          </div>
        ) : (
          <span className="sr-only" data-testid="staff-console-badge">
            {t('admin.brand.badge')}
          </span>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.labelKey} className="flex flex-col gap-1">
            {!collapsed ? (
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
                  title={collapsed ? t(item.labelKey) : undefined}
                  className={cx(
                    'flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-ui transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-bg',
                    active
                      ? 'bg-sidebar-active font-medium text-sidebar-active-fg'
                      : 'text-sidebar-fg hover:bg-surface-2',
                  )}
                >
                  <Icon aria-hidden size={18} className="shrink-0" strokeWidth={1.75} />
                  {!collapsed ? <span className="truncate">{t(item.labelKey)}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="flex shrink-0 items-center justify-end border-t border-sidebar-border p-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          data-testid="sidebar-collapse-toggle"
          onClick={() => {
            const next = !collapsed;
            onCollapsedChange(next);
            writeStoredCollapsed(next);
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-muted hover:bg-surface-2 hover:text-sidebar-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? (
            <ChevronsRight aria-hidden size={16} />
          ) : (
            <ChevronsLeft aria-hidden size={16} />
          )}
          <span className="sr-only">{t('admin.sidebar.collapse')}</span>
        </button>
      </div>
    </div>
  );
}
