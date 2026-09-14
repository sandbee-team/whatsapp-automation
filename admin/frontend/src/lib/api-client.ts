/**
 * lib/api-client.ts (P28 Unit U6, step 9) - the ONLY place admin/frontend
 * calls the network. Every feature's `api.ts` goes through `adminFetch`/
 * `adminMutate`, never a raw `fetch` to an absolute URL (the dev proxy in
 * vite.config.ts requires same-origin relative paths so the
 * `SameSite=Strict` + `Secure` `wp_admin_rt` refresh cookie works).
 *
 * The access token lives in memory only (module state) - never
 * localStorage/sessionStorage (XSS-exfiltrable). On a 401 this client makes
 * ONE automatic `POST /admin/v1/auth/refresh` attempt, retries the original
 * request once, and otherwise clears state and redirects to `/login`. Two
 * concurrent 401s share the SAME in-flight refresh (`refreshInFlight`) so a
 * second caller never races the first's cookie rotation.
 */
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
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Internal: set on the retry attempt to prevent an infinite refresh loop. */
  isRetry?: boolean;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length > 0 ? JSON.parse(text) : undefined;
}

/** Shared in-flight refresh promise - see module header for why this must be shared. */
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch('/admin/v1/auth/refresh', {
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
 * token already exists, or the shared one-shot refresh succeeds. The
 * `_authed` route guard calls this before rendering any protected route.
 */
export async function ensureStaffSession(): Promise<boolean> {
  if (accessToken) return true;
  return attemptRefresh();
}

/**
 * Calls a relative `/admin/v1/...` path with `credentials: 'include'`
 * (refresh cookie) and the in-memory access token as a Bearer header.
 * Returns the parsed `data` payload on success; throws `ApiError` on the
 * error envelope.
 */
export async function adminFetch<TResponse>(
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

  if (response.status === 401 && !isRetry) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      return adminFetch<TResponse>(path, { method, body, headers: extraHeaders, isRetry: true });
    }
    setAccessToken(null);
    redirectToLogin();
  }

  throw await toApiError(response);
}

/**
 * `adminMutate` is the ONE path every mutation dialog uses: it requires an
 * `idempotencyKey` (one uuidv7 per user action, reused verbatim on the
 * automatic 401-retry - see `staff-action-dialog.tsx`) and sets it as the
 * `Idempotency-Key` header (`adminMutationHeadersSchema`).
 */
export interface AdminMutateOptions {
  idempotencyKey: string;
  method?: 'POST' | 'PUT';
}

export function adminMutate<TResponse>(
  path: string,
  body: unknown,
  options: AdminMutateOptions,
): Promise<TResponse> {
  return adminFetch<TResponse>(path, {
    method: options.method ?? 'POST',
    body,
    headers: { 'Idempotency-Key': options.idempotencyKey },
  });
}

/** `GET`s that carry a staff-typed reason send it via `X-Staff-Reason` (never a body - see admin/backend's `reasonOf`). */
export function adminReadWithReason<TResponse>(path: string, reason?: string): Promise<TResponse> {
  return adminFetch<TResponse>(path, {
    headers: reason ? { 'X-Staff-Reason': reason } : undefined,
  });
}

async function toApiError(response: Response): Promise<ApiError> {
  const json = (await parseJson(response)) as { error: ApiErrorBody } | undefined;
  if (!json?.error) {
    return new ApiError(response.status, {
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
      requestId: 'unknown',
    });
  }
  return new ApiError(response.status, json.error);
}
