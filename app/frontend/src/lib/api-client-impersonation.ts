/**
 * api-client-impersonation.ts (P28 Unit U7) - split out of `api-client.ts`
 * (which was already at 300/300 lines - same "sibling module, never trim a
 * behaviour comment to make room" idiom as `session-worker-discovery-
 * wiring.ts`). Holds the `sessionStorage` impersonation-session flag and the
 * impersonation-specific refresh call; `api-client.ts` imports both and
 * keeps owning `accessToken`, `attemptRefresh`'s branch, and every other
 * request path unchanged.
 *
 * Impersonated sessions never hold the `SameSite=Strict` refresh cookie -
 * the impersonation token was minted for a staff grant, not a normal login,
 * so there is no cookie to rotate. Refreshing one instead means presenting
 * the CURRENT (still-live) impersonation bearer token to a dedicated
 * endpoint that re-mints a short-lived token from the same grant,
 * `credentials` omitted (no cookie involved either way).
 */

const IMPERSONATION_FLAG_KEY = 'wp.imp';

export function markImpersonatedSession(): void {
  try {
    window.sessionStorage.setItem(IMPERSONATION_FLAG_KEY, '1');
  } catch {
    // Storage unavailable - the session still works, it just cannot
    // recognise itself as impersonated for refresh-routing purposes.
  }
}

export function clearImpersonatedSession(): void {
  try {
    window.sessionStorage.removeItem(IMPERSONATION_FLAG_KEY);
  } catch {
    // See markImpersonatedSession - storage access is best-effort.
  }
}

export function isImpersonatedSession(): boolean {
  try {
    return window.sessionStorage.getItem(IMPERSONATION_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

export async function attemptImpersonationRefresh(
  currentToken: string | null,
  setAccessToken: (token: string | null) => void,
): Promise<boolean> {
  if (!currentToken) return false;

  try {
    const response = await fetch('/v1/auth/impersonation/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${currentToken}` },
    });
    if (!response.ok) return false;

    const json = (await parseJson(response)) as { data?: { accessToken?: string } } | undefined;
    const token = json?.data?.accessToken;
    if (!token) return false;

    setAccessToken(token);
    return true;
  } catch {
    return false;
  }
}
