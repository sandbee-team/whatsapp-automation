import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Button, ErrorState, useT } from '@wp/ui';
import { AuthLayout } from '../components/auth-layout.js';
import { markImpersonatedSession, setAccessToken } from '../lib/api-client.js';

/**
 * `/impersonate#token=<jwt>&exp=<iso>` (P28 Unit U7) - PUBLIC entry point
 * for a staff-minted support session. No `_authed` guard: the session does
 * not exist yet when this route renders, this route is what creates it.
 *
 * The token arrives in the URL **fragment**, never the query string: a
 * fragment is not sent to the server and never lands in an access log or a
 * `Referer` header. It is then held in memory only (`setAccessToken`) and
 * NEVER written to `localStorage` - only the boolean "this session is
 * impersonated" flag goes to `sessionStorage`, so a refresh routes to the
 * bearer endpoint but the token itself dies with the tab. `replaceState`
 * strips the fragment immediately so the token is not visible in the URL
 * bar and is not recoverable from session history either.
 */
export const Route = createFileRoute('/impersonate')({
  component: ImpersonateRoute,
});

function readTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  return token !== null && token.length > 0 ? token : null;
}

function ImpersonateRoute(): React.JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const [failed, setFailed] = React.useState(false);

  // One-shot entry effect with intentionally empty deps: the fragment is
  // consumed exactly once per mount (it is destroyed by `replaceState`
  // immediately after), so re-running on a changed `navigate` identity would
  // find no token and wrongly report failure.
  React.useEffect(() => {
    const token = readTokenFromHash(window.location.hash);
    if (!token) {
      setFailed(true);
      return;
    }

    setAccessToken(token);
    markImpersonatedSession();

    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    } catch {
      // A `replaceState` failure (exotic embedding) must not strand the
      // support session on this page - the token is already in memory.
    }

    void navigate({ to: '/', replace: true });
  }, []);

  if (failed) {
    return (
      <AuthLayout title={t('impersonation.entry.invalidTitle')}>
        <ErrorState
          data-testid="impersonate-entry-error"
          title={t('impersonation.entry.invalidTitle')}
          body={t('impersonation.entry.invalidBody')}
          retryAction={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="impersonate-entry-return-to-login"
              onClick={() => void navigate({ to: '/login' })}
            >
              {t('impersonation.entry.returnToLoginButton')}
            </Button>
          }
        />
      </AuthLayout>
    );
  }

  return <div data-testid="impersonate-entry-pending" />;
}
