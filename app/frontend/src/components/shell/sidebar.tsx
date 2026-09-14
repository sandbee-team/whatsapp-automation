import * as React from 'react';
import { useRouterState } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Badge, cx, useT, type BadgeTone } from '@wp/ui';
import { BrandMark } from '../brand/brand-mark.js';
import { SidebarNav } from './sidebar-nav.js';
import { SidebarWalletCard } from './sidebar-wallet-card.js';
import type { RealtimeConnectionState } from '../../lib/sse.js';

/**
 * Sidebar (panel refresh spec section 4, unit S1) - `w-64` desktop sidebar,
 * collapsible to a `w-16` icon rail. Collapse state persists to
 * `localStorage['wp.sidebar']` (try/catch-wrapped). Brand row renders
 * `BrandMark` (section 9: "WA Automation" / "by Sandbee", `companyName` folded
 * into the "by" line), sized down and text-less in rail mode but still a
 * working link; footer carries the wallet mini-card (hidden in rail mode and
 * below a 780px-tall viewport - the card itself owns its loading/error
 * states), then a status row (realtime chip with a pulsing ring when live,
 * plus the collapse toggle).
 * The theme control moved to the top bar (`ThemeMenu` is no longer mounted
 * here) - only the locale switch stayed off the sidebar from the start.
 *
 * Defect A fix (768px-tall viewport overflow): brand row tightened to `h-14
 * px-3` (was `h-16 px-4`), nav items to `h-9` with an internal scrollbar (see
 * `sidebar-nav.tsx`), wallet card compacted and viewport-hidden below 780px
 * (see `sidebar-wallet-card.tsx`). Budget: 56px (brand, h-14) + ~540px (nav:
 * 10 items x 36px + 4 group labels x ~24px + 3 group gaps x 20px (gap-5) +
 * 16px vertical padding) + ~152px (footer: wallet card ~92px + gap-3 12px +
 * status row 32px + p-3 24px) ≈ 748px ≤ 768px.
 */
const SIDEBAR_STORAGE_KEY = 'wp.sidebar';

const REALTIME_TONE: Record<RealtimeConnectionState, BadgeTone> = {
  live: 'success',
  reconnecting: 'warning',
  offline: 'danger',
};

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
  companyName: string;
  realtimeState: RealtimeConnectionState;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Renders without the fixed desktop chrome, for reuse inside the mobile sheet. */
  variant?: 'desktop' | 'mobile';
}

export function Sidebar({
  companyName,
  realtimeState,
  collapsed,
  onCollapsedChange,
  variant = 'desktop',
}: SidebarProps): React.JSX.Element {
  const t = useT();
  const currentPath = useRouterState({ select: (state) => state.location.pathname });
  const isRail = variant === 'desktop' && collapsed;
  const isLive = realtimeState === 'live';

  return (
    <div
      className={cx(
        'flex h-full flex-col bg-sidebar text-sidebar-fg',
        variant === 'desktop' && 'border-r border-sidebar-border',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <BrandMark
          size={isRail ? 'sm' : 'md'}
          showText={!isRail}
          variant="sidebar"
          meta={companyName}
        />
      </div>

      <SidebarNav currentPath={currentPath} isRail={isRail} />

      <div className="flex shrink-0 flex-col gap-3 border-t border-sidebar-border p-3">
        {!isRail ? <SidebarWalletCard /> : null}

        <div className="flex items-center justify-between gap-2">
          <Badge tone={REALTIME_TONE[realtimeState]} data-testid="realtime-chip" size="sm" dot>
            <span className="relative inline-flex items-center">
              {isLive ? (
                <span
                  aria-hidden="true"
                  className="absolute -left-3 h-2 w-2 rounded-full bg-success motion-reduce:animate-none animate-pulse-ring"
                />
              ) : null}
              <span className={isRail ? 'sr-only' : undefined}>
                {t(`realtime.${realtimeState}`)}
              </span>
            </span>
          </Badge>
          {variant === 'desktop' ? (
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
              <span className="sr-only">{t('shell.sidebar.collapse')}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
