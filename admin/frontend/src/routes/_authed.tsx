import { createFileRoute, redirect } from '@tanstack/react-router';
import { ToastProvider, useT } from '@wp/ui';
import { AdminShell } from '../components/admin-shell.js';
import { me } from '../features/auth/index.js';
import { ensureStaffSession } from '../lib/api-client.js';

/**
 * `_authed` (P28 Unit U6, step 9) - the pathless auth-guard layout, mirrors
 * app/frontend's route of the same name. `beforeLoad` awaits the shared
 * one-shot refresh; a failed refresh redirects to `/login` before anything
 * protected renders. `loader` loads `me()` into route context so
 * `AdminShell` and its children never issue a second identical fetch.
 */
function AuthedShell(): React.JSX.Element {
  const t = useT();
  return (
    <ToastProvider dismissLabel={t('admin.common.close')}>
      <AdminShell />
    </ToastProvider>
  );
}

export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
    const authenticated = await ensureStaffSession();
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
