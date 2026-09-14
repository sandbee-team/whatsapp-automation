import type { ZodType } from 'zod';
import { buildServiceTokenHeader } from '@wp/server-kit/auth';

/**
 * modules/internal-client/internal-client.ts (P28 Unit U4, step 6) - the
 * ONLY outbound caller of app-backend's `/internal/v1` surface, and
 * therefore the only place admin-backend causes a side effect anywhere.
 * ADR 0014 fact 1/12: admin/backend NEVER writes tenant or send-path data;
 * every mutation is an S2S call from here, so the durable-queue, health-FSM
 * and staff-audit invariants keep exactly one owner (app-backend).
 *
 * THE HEADER CONTRACT (must match
 * `app/backend/src/modules/internal/internal-access.ts` exactly - its own
 * test suite is the other half of this contract):
 *  - `X-WP-Internal-Token: t=<unix>,s=<hex>` =
 *    `buildServiceTokenHeader(secret, method, CONCRETE path, unixSeconds)`.
 *    The signed path is the concrete request path with the query string
 *    stripped - NEVER the route template. This is a security boundary: a
 *    token signed over `/internal/v1/clients/:id/suspend` would be valid
 *    for every client, so one captured header would suspend any workspace.
 *  - `X-Actor: staff:<uuid>` - the acting staff member. app-backend
 *    re-resolves this against `staff_users` and re-checks
 *    `canStaff(role, action)` server-side; the admin panel's own RBAC is
 *    never trusted as the authority.
 *  - `Idempotency-Key` - ONE key per user action, reused across retries.
 *  - The staff `reason` travels in the JSON BODY (every `/internal/v1`
 *    mutation input schema requires it), never in a header.
 *
 * RETRY POLICY: at most two retries, on a network error or 502/503/504
 * only - NEVER on any 4xx. A 4xx is a decision app-backend already made
 * (validation, RBAC, conflict); retrying it cannot change the answer and
 * would only re-log the attempt. Retries reuse the SAME idempotency key, so
 * app-backend replays the first outcome instead of applying the action
 * twice (core invariant 3 - the dedupe authority is a unique constraint in
 * `staff_audit_log`, not this client's care).
 *
 * A retried 5xx is deliberately NOT downgraded to "probably applied": the
 * error surfaces to the staff member, who can re-issue the action with the
 * same key and get the replayed result. Silently reporting success for a
 * mutation whose outcome is unknown is exactly the failure mode core
 * invariant 2 (fail-safe) forbids.
 */

/** Injected so tests can stub the transport; production passes `globalThis.fetch`. */
export type InternalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export interface InternalClientDeps {
  baseUrl: string;
  serviceTokenSecret: string;
  fetch: InternalFetch;
  now?: () => Date;
  /** Overall per-attempt timeout; defaults to 10s. */
  timeoutMs?: number;
  /** Max retries AFTER the first attempt (see the module header) - defaults to 2. */
  maxRetries?: number;
  /** Injected so a test never sleeps for real (`.claude/rules/queue-workers.md`: no sleeps in tests) - defaults to a real `setTimeout`-backed delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected so a test asserts the EXACT backoff value - defaults to `Math.random`. */
  random?: () => number;
}

export interface CallInternalInput<TOut> {
  method: 'POST' | 'PUT' | 'GET' | 'DELETE';
  /** CONCRETE path, no query string - e.g. `/internal/v1/clients/<uuid>/suspend`. */
  path: string;
  actor: { staffId: string };
  idempotencyKey: string;
  body?: unknown;
  /** The matching `internalContract` output schema - the response envelope is parsed with it, never trusted raw. */
  outputSchema: ZodType<TOut>;
}

/**
 * Carries the internal API's OWN error code and status through unchanged, so
 * the admin route can reply with the same verdict app-backend reached rather
 * than flattening every failure to 500 (a staff member seeing `FORBIDDEN`
 * learns something true; seeing `INTERNAL` does not).
 */
export class InternalCallError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: string;
    status: number;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = 'InternalCallError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const BACKOFF_BASE_MS = 200;
const BACKOFF_JITTER_MS = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `200ms * 2^attempt + random(0..100ms)` - `attempt` is the FAILED attempt's own 0-based index, so the retry that follows attempt 0 waits `250`ish ms, the retry following attempt 1 waits `450`ish ms. */
function backoffDelayMs(attempt: number, random: () => number): number {
  return BACKOFF_BASE_MS * 2 ** attempt + random() * BACKOFF_JITTER_MS;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function toInternalCallError(status: number, parsed: unknown): InternalCallError {
  const envelope = parsed as ErrorEnvelope | null;
  const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'INTERNAL';
  const message =
    typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : 'The internal API call failed.';
  const details =
    envelope?.error?.details && typeof envelope.error.details === 'object'
      ? (envelope.error.details as Record<string, unknown>)
      : undefined;
  return new InternalCallError({ code, status, message, details });
}

/** Calls one `/internal/v1` route. See the module header for the full header/retry contract. */
export async function callInternal<TOut>(
  deps: InternalClientDeps,
  input: CallInternalInput<TOut>,
): Promise<TOut> {
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const serialisedBody = input.body === undefined ? undefined : JSON.stringify(input.body);
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      // Backoff + jitter BEFORE each retry, never before the first attempt -
      // `attempt - 1` is the failed attempt's own 0-based index (see
      // `backoffDelayMs`'s own doc).
      await sleep(backoffDelayMs(attempt - 1, random));
    }
    // Re-signed per attempt: the token carries a timestamp inside a
    // 5-minute window, so a retry after a slow first attempt must not reuse
    // a stale signature. The IDEMPOTENCY key, by contrast, is deliberately
    // identical across attempts - see the module header.
    const now = deps.now ? deps.now() : new Date();
    const headers: Record<string, string> = {
      'X-WP-Internal-Token': buildServiceTokenHeader(
        deps.serviceTokenSecret,
        input.method,
        input.path,
        Math.floor(now.getTime() / 1000),
      ),
      'X-Actor': `staff:${input.actor.staffId}`,
      'Idempotency-Key': input.idempotencyKey,
      'Content-Type': 'application/json',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}${input.path}`, {
        method: input.method,
        headers,
        body: serialisedBody,
        signal: controller.signal,
      });
    } catch {
      // Network-class failure (including our own timeout abort) - retryable.
      lastError = new InternalCallError({
        code: 'INTERNAL',
        status: 502,
        message: 'The internal API is unreachable.',
      });
      continue;
    } finally {
      clearTimeout(timer);
    }

    const parsed: unknown = await response.json().catch(() => null);

    if (response.ok) {
      const envelope = parsed as { data?: unknown } | null;
      return input.outputSchema.parse(envelope?.data);
    }

    const callError = toInternalCallError(response.status, parsed);
    if (!RETRYABLE_STATUSES.has(response.status)) {
      // Any 4xx (and any non-listed 5xx) is app-backend's own decision -
      // never retried, see the module header.
      throw callError;
    }
    lastError = callError;
  }

  throw lastError instanceof InternalCallError
    ? lastError
    : new InternalCallError({
        code: 'INTERNAL',
        status: 502,
        message: 'The internal API call failed after retries.',
      });
}
