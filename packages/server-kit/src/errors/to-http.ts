import { errorEnvelopeSchema } from '@wp/contracts';
import type { ErrorEnvelope } from '@wp/contracts';
import { AppError } from './app-error.js';
import { toHttpErrorCode } from './codes.js';

export type HttpErrorResponse = {
  status: number;
  body: ErrorEnvelope;
};

/**
 * Generic message for every non-exposed `AppError` and every unknown thrown
 * value - never the underlying message, `cause`, or stack. Rendering detail
 * requires an explicit `expose: true` at the throw site (core invariant:
 * fail-safe over informative-by-default).
 */
const GENERIC_INTERNAL_MESSAGE = 'An internal error occurred.';

/**
 * Maps any thrown value to the `@wp/contracts` HTTP error envelope + status.
 *
 * - `AppError` with `expose: true` -> its own code (mapped through
 *   `toHttpErrorCode` for internal codes) and its own message.
 * - `AppError` with `expose: false`, or any non-`AppError` value (including
 *   `CryptoError`, which is always non-exposed) -> 500 `INTERNAL` with a
 *   fixed generic message. The `requestId` is always the caller-supplied id;
 *   no stack, cause, or internal text ever reaches the envelope.
 */
export function toHttpEnvelope(err: unknown, requestId: string): HttpErrorResponse {
  if (err instanceof AppError && err.expose) {
    const body = errorEnvelopeSchema.parse({
      error: {
        code: toHttpErrorCode(err.code),
        message: err.message,
        requestId,
      },
    });
    return { status: err.httpStatus, body };
  }

  const body = errorEnvelopeSchema.parse({
    error: {
      code: 'INTERNAL',
      message: GENERIC_INTERNAL_MESSAGE,
      requestId,
    },
  });
  return { status: 500, body };
}
