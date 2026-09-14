import * as React from 'react';
import { Outlet } from '@tanstack/react-router';
import { getRouteApi } from '@tanstack/react-router';
import { Sidebar, readStoredCollapsed } from './sidebar.js';
import { TopBar } from './top-bar.js';

const authedRoute = getRouteApi('/_authed');

/**
 * admin-shell.tsx (P28 Unit U6, step 9) - fixed desktop sidebar (collapsible
 * to an icon rail), sticky top bar, content area (`mx-auto max-w-[1400px]
 * px-6 py-6`), design brief section 3. No SSE/realtime chip in this phase -
 * the staff console has no equivalent live-connection surface yet.
 */
const SIDEBAR_WIDTH_EXPANDED = '16rem';
const SIDEBAR_WIDTH_COLLAPSED = '4rem';

export function AdminShell(): React.JSX.Element {
  const { me } = authedRoute.useLoaderData();
  const [collapsed, setCollapsed] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  React.useEffect(() => {
    setCollapsed(readStoredCollapsed());
  }, []);

  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div
      className="flex min-h-screen bg-bg text-fg"
      style={{ '--wp-sidebar-w': sidebarWidth } as React.CSSProperties}
    >
      <aside className="hidden w-[var(--wp-sidebar-w)] shrink-0 transition-[width] duration-150 lg:block">
        <div className="sticky top-0 h-screen">
          <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
        </div>
      </aside>

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-overlay"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
          <div className="relative h-full w-64">
            <Sidebar collapsed={false} onCollapsedChange={setCollapsed} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar me={me} onOpenMobileNav={() => setMobileNavOpen(true)} />
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
