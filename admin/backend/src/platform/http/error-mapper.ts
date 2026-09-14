import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

/**
 * platform/http/error-mapper.ts (P28 Unit U4, step 6) - EVERY admin response
 * goes through here. A typed error (any `Error` carrying a known `code`) maps
 * to `{ error: { code, message, details?, requestId } }` with the matching
 * status; an unknown throwable maps to `INTERNAL` with its message STRIPPED.
 *
 * Never a stack, never a driver message, never a raw pg error - on an admin
 * surface those would leak table names, constraint names and sometimes the
 * offending row's own values (which is tenant data) to whoever triggered the
 * error. The server-side log gets `{requestId, name, code}` only, for the
 * same reason.
 *
 * The status map is local rather than imported from `@wp/contracts`'
 * `ERROR_CODE_TO_HTTP_STATUS` because admin-backend adds codes the tenant
 * API has no notion of (`ACCOUNT_LOCKED`, `MFA_ENROLL_REQUIRED` as a staff
 * refusal) and omits tenant-only ones; keeping it local means an admin code
 * cannot silently acquire a tenant-side status meaning.
 */

const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  MFA_ENROLL_REQUIRED: 403,
  ACCOUNT_LOCKED: 423,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
});

interface CodedError extends Error {
  code: string;
  details?: Record<string, unknown>;
}

function isCodedError(err: unknown): err is CodedError {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code in STATUS_BY_CODE;
}

// An inbound x-request-id is trusted only when it matches this shape - an
// arbitrary header would otherwise flow straight into logs and response bodies.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Per-request id, present on both the success and error envelopes. */
export function requestIdFor(req: FastifyRequest): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

/** Maps `err` to the standard envelope and sends it - the ONLY place an admin error body is built. */
export function sendError(reply: FastifyReply, requestId: string, err: unknown): void {
  if (err instanceof z.ZodError) {
    // Field-level detail is safe here: it describes the caller's OWN request
    // shape, never stored data.
    reply.code(STATUS_BY_CODE.VALIDATION_ERROR ?? 400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        details: { issues: err.issues.map((issue) => issue.path.join('.')) },
        requestId,
      },
    });
    return;
  }

  if (isCodedError(err)) {
    reply.code(STATUS_BY_CODE[err.code] ?? 500).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
        requestId,
      },
    });
    return;
  }

  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: unknown } | null)?.code;
  console.error('admin request error:', { requestId, name, code });
  reply.code(500).send({
    error: { code: 'INTERNAL', message: 'An unexpected error occurred.', requestId },
  });
}

/** Sends the standard success envelope `{ data, meta: { requestId } }`. */
export function sendSuccess<T>(
  reply: FastifyReply,
  requestId: string,
  data: T,
  status = 200,
): void {
  reply.code(status).send({ data, meta: { requestId } });
}
