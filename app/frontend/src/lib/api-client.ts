/**
 * api-client.ts - the ONLY place app/frontend calls the network. Every
 * feature's `api.ts` goes through `apiFetch`, never a raw `fetch` to an
 * absolute URL (the dev proxy in vite.config.ts requires same-origin
 * relative paths so the `SameSite=Strict` + `Secure` refresh cookie works -
 * see vite.config.ts's doc comment).
 *
 * The access token lives in memory only (module state) - never
 * localStorage/sessionStorage (XSS-exfiltrable). On a 401 this client makes
 * ONE automatic `POST /v1/auth/refresh` attempt, retries the original
 * request once, and otherwise clears state and redirects to /login.
 *
 * Impersonated-session refresh routing (P28 Unit U7) lives in the sibling
 * `api-client-impersonation.ts` (300-line-cap split) - re-exported here so
 * every existing caller keeps importing from this one module.
 */
import {
  attemptImpersonationRefresh,
  clearImpersonatedSession,
  isImpersonatedSession,
} from './api-client-impersonation.js';

export {
  markImpersonatedSession,
  clearImpersonatedSession,
  isImpersonatedSession,
} from './api-client-impersonation.js';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.requestId = body.requestId;
  }
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /**
   * Extra request headers merged in after `Content-Type`/`Authorization`
   * (P11 U6a: `POST /v1/messages`'s mandatory `Idempotency-Key`). Never
   * lets a caller override `Content-Type`/`Authorization` themselves - both
   * are always derived here, not from caller input.
   */
  headers?: Record<string, string>;
  /** Internal: set on the retry attempt to prevent an infinite refresh loop. */
  isRetry?: boolean;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/**
 * Shared in-flight refresh promise: the refresh cookie is a ONE-SHOT
 * rotating token (backend `session.service.ts` rotation claim gate - only
 * ONE of two concurrent `/v1/auth/refresh` calls presenting the same cookie
 * can win the rotation; the second is correctly treated as reuse and
 * revokes the whole session chain, canon behavior, never to be changed
 * client-side). Two callers racing a 401 at the same moment (e.g. a
 * StrictMode double-invoked effect firing two requests with no/expired
 * Bearer token) must therefore await the SAME refresh attempt instead of
 * each issuing their own - otherwise the second caller's refresh is a
 * guaranteed reuse-detection revocation of a session the first caller just
 * legitimately rotated.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (isImpersonatedSession()) {
      return attemptImpersonationRefresh(accessToken, setAccessToken);
    }

    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) return false;

      const json = (await parseJson(response)) as { data?: { accessToken?: string } } | undefined;
      const token = json?.data?.accessToken;
      if (!token) return false;

      setAccessToken(token);
      return true;
    } catch {
      // A transport-level failure (network down, DNS, etc.) must resolve to
      // "refresh failed", not escape as a raw TypeError - apiFetch's callers
      // only ever expect ApiError or a resolved value from this path (P04b
      // FIXF, C1 MINOR-2).
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function redirectToLogin(): void {
  if (typeof window !== 'undefined') {
    window.location.assign('/login');
  }
}

/**
 * Returns true if a valid session is available: either an in-memory access
 * token already exists, or the shared one-shot refresh (see
 * `attemptRefresh` above) succeeds. Callers that need a session before doing
 * anything else (the `_authed` route guard, `lib/sse.ts`'s 401 handling)
 * call this instead of reaching into `attemptRefresh`/`refreshInFlight`
 * directly, so the rotation-safe sharing semantics are never duplicated
 * outside this module.
 */
export async function ensureSession(): Promise<boolean> {
  if (accessToken) return true;
  return attemptRefresh();
}

/**
 * Calls a relative `/v1/...` path with `credentials: 'include'` (refresh
 * cookie) and the in-memory access token as a Bearer header. Returns the
 * parsed `data` payload on success; throws `ApiError` on the error envelope.
 */
export async function apiFetch<TResponse>(
  path: string,
  options: RequestOptions = {},
): Promise<TResponse> {
  const { method = 'GET', body, headers: extraHeaders, isRetry = false } = options;

  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.ok) {
    const json = (await parseJson(response)) as { data: TResponse };
    return json.data;
  }

  const retried = await retryOnceOn401<TResponse>(response, isRetry, () =>
    apiFetch<TResponse>(path, { method, body, headers: extraHeaders, isRetry: true }),
  );
  if (retried.handled) {
    return retried.result;
  }

  throw await toApiError(response);
}

/**
 * Raw-body variant of `apiFetch` (P20 Unit U9, step 10) - for CSV upload
 * (`Content-Type: text/csv` with the raw file body) and blob downloads
 * (export.csv / errors.csv), where the body is never JSON and the response
 * is consumed as a stream/blob rather than parsed as an envelope. Shares the
 * SAME in-memory Bearer token, `credentials: 'include'`, and one-shot 401
 * refresh-and-retry logic as `apiFetch` via `retryOnceOn401` - `apiFetch`'s
 * own observable behaviour is unchanged by this addition.
 */
export interface RawRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: BodyInit;
  contentType?: string;
  accept?: string;
  /** Internal: set on the retry attempt to prevent an infinite refresh loop. */
  isRetry?: boolean;
}

export async function apiFetchRaw(
  path: string,
  options: RawRequestOptions = {},
): Promise<Response> {
  const { method = 'GET', body, contentType, accept, isRetry = false } = options;

  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (accept) headers.Accept = accept;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body,
  });

  if (response.ok) {
    return response;
  }

  const retried = await retryOnceOn401<Response>(response, isRetry, () =>
    apiFetchRaw(path, { method, body, contentType, accept, isRetry: true }),
  );
  if (retried.handled) {
    return retried.result;
  }

  throw await toApiError(response);
}

type RetryOutcome<TResponse> = { handled: true; result: TResponse } | { handled: false };

/**
 * Shared one-shot 401 refresh-and-retry step used by both `apiFetch` and
 * `apiFetchRaw`: on a 401 that is not itself an `MFA_REQUIRED` error and not
 * already a retry, attempts the shared rotation-safe refresh
 * (`attemptRefresh`) and, on success, re-issues the ORIGINAL request once via
 * `retryRequest`. On refresh failure, clears the in-memory token and
 * redirects to `/login`, same as before this helper existed.
 */
async function retryOnceOn401<TResponse>(
  response: Response,
  isRetry: boolean,
  retryRequest: () => Promise<TResponse>,
): Promise<RetryOutcome<TResponse>> {
  if (response.status !== 401 || isRetry) {
    return { handled: false };
  }

  const errorBody = await peekErrorBody(response);
  if (errorBody?.code === 'MFA_REQUIRED') {
    return { handled: false };
  }

  const refreshed = await attemptRefresh();
  if (refreshed) {
    return { handled: true, result: await retryRequest() };
  }

  setAccessToken(null);
  clearImpersonatedSession();
  redirectToLogin();
  return { handled: false };
}

/** Reads the error envelope from a cloned response so the original body stream stays consumable by the caller. */
async function peekErrorBody(response: Response): Promise<ApiErrorBody | undefined> {
  const json = (await parseJson(response.clone())) as { error: ApiErrorBody } | undefined;
  return json?.error;
}

async function toApiError(response: Response): Promise<ApiError> {
  const errorBody = await peekErrorBody(response);
  if (!errorBody) {
    return new ApiError(response.status, {
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
      requestId: 'unknown',
    });
  }
  return new ApiError(response.status, errorBody);
}
