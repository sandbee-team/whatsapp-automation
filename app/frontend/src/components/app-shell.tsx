import * as React from 'react';
import { getRouteApi, Outlet, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Reveal } from '@wp/ui';
import { acquireRealtimeConnection, type RealtimeConnectionState } from '../lib/sse.js';
import { Sidebar, readStoredCollapsed } from './shell/sidebar.js';
import { TopBar } from './shell/top-bar.js';
import { MobileNav } from './shell/mobile-nav.js';
import { CommandPaletteHost } from './shell/command-palette-host.js';

const authedRoute = getRouteApi('/_authed');

/**
 * AppShell (P26b U2, design brief section 3) - fixed desktop sidebar
 * (collapsible to an icon rail), sticky top bar, content area
 * (`mx-auto max-w-[1400px] px-6 py-6`), mobile nav sheet and command
 * palette. Reads the workspace's `companyName` from the `_authed` route
 * loader's `me()` result (`getRouteApi('/_authed').useLoaderData()`), so no
 * child route ever issues a second identical fetch. Acquires the one shared
 * SSE connection for the lifetime of the mount and releases it on unmount
 * (StrictMode-safe via `lib/sse.ts`'s ref-counted singleton) - unchanged
 * from the P05 implementation this file replaces. The desktop content
 * column sits next to a sticky in-flow sidebar whose width is a CSS custom property (`--wp-sidebar-w`)
 * rather than a Tailwind class swap, so collapse never needs two parallel
 * subtrees.
 */
export interface AppShellProps {
  /** Slot rendered left of the bell in the top bar (U3 mounts the instance switcher there). */
  topBarExtra?: React.ReactNode;
}

const SIDEBAR_WIDTH_EXPANDED = '16rem';
const SIDEBAR_WIDTH_COLLAPSED = '4rem';

export function AppShell({ topBarExtra }: AppShellProps = {}): React.JSX.Element {
  const { me } = authedRoute.useLoaderData();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [realtimeState, setRealtimeState] = React.useState<RealtimeConnectionState>('reconnecting');
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);

  React.useEffect(() => {
    setCollapsed(readStoredCollapsed());
  }, []);

  React.useEffect(() => {
    const handle = acquireRealtimeConnection({
      queryClient,
      onStateChange: setRealtimeState,
    });
    return () => {
      handle.release();
    };
  }, [queryClient]);

  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div
      className="flex min-h-screen bg-bg text-fg"
      style={{ '--wp-sidebar-w': sidebarWidth } as React.CSSProperties}
    >
      <aside className="hidden w-[var(--wp-sidebar-w)] shrink-0 bg-sidebar transition-[width] duration-150 lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar
            companyName={me.client.companyName}
            realtimeState={realtimeState}
            collapsed={collapsed}
            onCollapsedChange={setCollapsed}
          />
        </div>
      </aside>

      <MobileNav
        open={mobileNavOpen}
        onOpenChange={setMobileNavOpen}
        companyName={me.client.companyName}
        realtimeState={realtimeState}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          me={me}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          extra={topBarExtra}
        />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Reveal key={pathname} variant="rise">
            <Outlet />
          </Reveal>
        </main>
      </div>

      <CommandPaletteHost open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
    </div>
  );
}
