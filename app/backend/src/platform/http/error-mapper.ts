import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODE_TO_HTTP_STATUS, type ErrorCode } from '@wp/contracts';
import { isMetadataOnly, redactMessageBodies } from '../../modules/identity/index.js';
import type { RateLimitResult } from './rate-limit.js';

/**
 * platform/http/error-mapper.ts (P04a Unit UA6) - EVERY response goes
 * through here (canon): typed `AppError`-style errors (any `Error` carrying
 * a `code: ErrorCode`) map via `@wp/contracts`'s `ERROR_CODE_TO_HTTP_STATUS`
 * to `{ error: { code, message, details?, requestId } }`; an unknown
 * throwable maps to `INTERNAL` with its message stripped - never a stack,
 * never raw driver/PII detail leaked to a client.
 */

export interface AppErrorLike extends Error {
  code: ErrorCode;
  details?: Record<string, unknown>;
}

function isAppError(err: unknown): err is AppErrorLike {
  if (!(err instanceof Error)) return false;
  const code = (err as unknown as { code?: unknown }).code;
  return typeof code === 'string' && code in ERROR_CODE_TO_HTTP_STATUS;
}

/** Rate-limited-specific typed error - carries the limiter result so the mapper can set standard headers. */
export class RateLimitedError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly result: RateLimitResult;
  constructor(result: RateLimitResult) {
    super('Too many requests - please try again later.');
    this.name = 'RateLimitedError';
    this.result = result;
  }
}

// M15 (P04a FIXB): an inbound x-request-id is only trusted when it matches
// this shape - an unbounded/arbitrary header would otherwise flow straight
// into logs and response bodies unchecked.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** requestId = per-request random id, present on both the success and error envelope shapes (canon). */
export function requestIdFor(req: FastifyRequest): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

function applyRateLimitHeaders(reply: FastifyReply, result: RateLimitResult): void {
  reply.header('Retry-After', String(Math.max(0, Math.ceil(result.retryAfterMs / 1000))));
  reply.header('RateLimit-Limit', String(result.limit));
  reply.header('RateLimit-Remaining', String(Math.max(0, result.remaining)));
  reply.header('RateLimit-Reset', String(Math.max(0, Math.ceil(result.resetMs / 1000))));
}

/** Maps `err` to the standard error envelope and sends it - the ONLY place a response error body is built. */
export function sendError(reply: FastifyReply, requestId: string, err: unknown): void {
  if (err instanceof RateLimitedError) {
    applyRateLimitHeaders(reply, err.result);
    reply.code(ERROR_CODE_TO_HTTP_STATUS.RATE_LIMITED).send({
      error: { code: err.code, message: err.message, requestId },
    });
    return;
  }

  if (isAppError(err)) {
    const status = ERROR_CODE_TO_HTTP_STATUS[err.code];
    reply.code(status).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  // Unknown throwable - INTERNAL, message stripped, never a stack (core rule:
  // no stack traces or PII). M16 (P04a FIXB): logs ONLY { requestId, name,
  // code } - never the raw message/stack, which can carry pg driver values
  // (e.g. a constraint violation's offending row data).
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: unknown } | null)?.code;
  console.error('unhandled request error:', { requestId, name, code });
  reply.code(ERROR_CODE_TO_HTTP_STATUS.INTERNAL).send({
    error: { code: 'INTERNAL', message: 'An unexpected error occurred.', requestId },
  });
}

/** Sends the standard success envelope `{ data, meta: { requestId } }` (canon). */
export function sendSuccess<T>(
  reply: FastifyReply,
  requestId: string,
  data: T,
  status = 200,
): void {
  reply.code(status).send({ data, meta: { requestId } });
}

/**
 * Same as `sendSuccess`, but deep-strips message-body-shaped fields
 * (`impersonation-principal.ts#redactMessageBodies`) when `req`'s principal
 * is a `metadata_only` impersonation session - a `with_message_bodies`
 * grant (or an ordinary, non-impersonation session) passes `data` through
 * unchanged. Every route whose response can carry message text uses THIS
 * instead of `sendSuccess` directly (P28 Unit U3c binding).
 */
export function sendImpersonationSafe<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  requestId: string,
  data: T,
  status = 200,
): void {
  sendSuccess(reply, requestId, isMetadataOnly(req) ? redactMessageBodies(data) : data, status);
}
