import { createFileRoute, redirect } from '@tanstack/react-router';
import { ToastProvider, useT } from '@wp/ui';
import { AppShell } from '../components/app-shell.js';
import { ImpersonationBanner } from '../components/impersonation-banner.js';
import { me } from '../features/auth/index.js';
import { ensureSession } from '../lib/api-client.js';
import { InstanceSwitcher } from '../features/instances/components/instance-switcher.js';

/**
 * `_authed` (P05 U5, phase step 7; P26b U3 mounts `ToastProvider` +
 * `InstanceSwitcher` here; P28 Unit U7 mounts `ImpersonationBanner`) - the
 * pathless auth-guard layout. Every protected route is a child of this one.
 * `beforeLoad` runs BEFORE any child route renders: if no in-memory access
 * token exists, it awaits the shared one-shot refresh (`ensureSession()`); a
 * failed refresh throws a `redirect` to `/login` so nothing protected ever
 * renders first. On success, `me()` is loaded into the route context so
 * `AppShell` and its children never issue a second identical fetch.
 * `ImpersonationBanner` renders ABOVE `AppShell` (never inside it) whenever
 * `me.impersonation` is present - a staff support session must stay visible
 * across every route, including above the sticky top bar. `ToastProvider` is
 * mounted here (not `app.tsx`, outside this unit's scope) because every
 * mutation toast in this phase (park/online, mark-read) fires from an authed
 * route; its own `dismissLabel` comes from `@wp/i18n`'s `common.close` key
 * via `useT()`, never a literal.
 */
function AuthedShell(): React.JSX.Element {
  const t = useT();
  const { me: meData } = Route.useLoaderData();
  return (
    <ToastProvider dismissLabel={t('common.close')}>
      {meData.impersonation ? <ImpersonationBanner impersonation={meData.impersonation} /> : null}
      <AppShell topBarExtra={<InstanceSwitcher />} />
    </ToastProvider>
  );
}

export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
    const authenticated = await ensureSession();
    if (!authenticated) {
      throw redirect({ to: '/login' });
    }
  },
  loader: async () => {
    const meResult = await me();
    return { me: meResult };
  },
  component: AuthedShell,
});
