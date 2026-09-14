import { z } from 'zod';

/**
 * The AppError code table - single source of truth for every code WP ever
 * renders to HTTP. Codes are SCREAMING_SNAKE (docs/CONVENTIONS.md §6.1/6.3).
 *
 * `ProviderError` deliberately has NO entry here: a provider error is
 * classified into a `RetryClass` by `@wp/domain`'s retry classifier
 * (RETRY_BACKOFF / PAUSE_INSTANCE / FAIL_PERMANENT / RECONCILE) and is never
 * rendered to HTTP directly - see
 * `.memory/research/2026-08-25-v1-design-repo-structure.md` §3.5.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'MFA_REQUIRED',
  'ENTITLEMENT_ERROR',
  'FORBIDDEN',
  'ACCOUNT_LOCKED',
  'MFA_ENROLL_REQUIRED',
  'EMAIL_NOT_VERIFIED',
  'NOT_FOUND',
  'CONFLICT',
  'INSTANCE_PAUSED',
  'REGISTERED_LIMIT_REACHED',
  'NO_FREE_SLOT',
  'INVALID_STATE',
  'RATE_LIMITED',
  'TOO_MANY_CONNECTIONS',
  'NOT_IMPLEMENTED',
  'INTERNAL',
  // P11 Unit U3: POST /v1/messages's enqueue-transaction error codes.
  'INSTANCE_UNLINKED',
  'IDEMPOTENCY_KEY_REUSED',
  // P14 Unit U4: the enqueue-time opt-out gate (createMessage) - a 422 since
  // this is a semantically-valid request body rejected for a business
  // reason (the recipient has opted out), never a 400 malformed-input shape
  // and never a plain 409 CONFLICT (no concurrent-write race is involved).
  'RECIPIENT_OPTED_OUT',
  // P15 Unit U5 (step 8): the webhook endpoint URL SSRF guard rejection at
  // configuration time - a 422 for the same reason as RECIPIENT_OPTED_OUT
  // (a semantically well-formed URL string rejected for a safety reason,
  // never a plain 400 malformed-input shape).
  'WEBHOOK_URL_REJECTED',
  // P16 Unit D (step 8): POST /v1/instances/:id/resume's own codes - a
  // non-user actor is a 403 (a distinct code from plain FORBIDDEN so a
  // client can tell "resume needs a human" apart from an entitlement/role
  // FORBIDDEN); a restriction-pause without the acknowledgement flag is a
  // 422 (same "well-formed body, rejected for a business reason" shape as
  // RECIPIENT_OPTED_OUT/WEBHOOK_URL_REJECTED above).
  'RESUME_REQUIRES_USER',
  'ACKNOWLEDGEMENT_REQUIRED',
  // P20 Unit U4 (step 4): the contacts `max_contacts` admission guard - a
  // distinct code from plain CONFLICT since it carries `{ limit, current,
  // reason }` details a client uses to render an upgrade prompt, never a
  // generic write-conflict retry.
  'CONTACT_LIMIT_REACHED',
  // P20 Unit U6 (step 5): the CSV upload cap and its content-type gate -
  // distinct codes so a client can tell "too big" from "wrong shape" apart,
  // same "one code per distinct failure kind" discipline as every other
  // entry above.
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  // P23 Unit U5 (step 6): every broadcast mutation route parses the
  // `Idempotency-Key` header FIRST, before the service is ever called - a
  // distinct code from the generic `VALIDATION_ERROR` so a client can tell
  // "you forgot the mandatory header" apart from a malformed body.
  'IDEMPOTENCY_KEY_REQUIRED',
  // P23 Unit U6 (step 7): POST /v1/broadcasts/:id/restamp's own code - the
  // caller's `confirmCount` did not match the server's live count of
  // blocked_needs_review/session_epoch_advanced rows for this campaign, so
  // NOTHING was re-stamped (a distinct code from plain CONFLICT because the
  // response carries `{ expected }` for the client to redisplay).
  'RESTAMP_COUNT_MISMATCH',
  // P24 (groups): a well-formed send/enable request to a group that is not
  // sendable right now - not send-enabled, announcement-only where this
  // number is a member, or over the per-instance tracked-device budget. A
  // 422 for the same reason as RECIPIENT_OPTED_OUT (business rejection of a
  // valid body), carrying `{ reason, ... }` details the panel renders.
  'GROUP_NOT_SENDABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Each code maps to exactly one HTTP status - this is the one table other
 * code reads from (never re-declared elsewhere). See
 * `every_error_code_maps_to_exactly_one_http_status` in
 * `tests/envelope.test.ts` for the invariant this encodes.
 *
 * Note: `RATE_LIMITED` (429) responses always carry a `Retry-After` header;
 * that is a transport-layer concern (set by the HTTP error mapper), not part
 * of this schema.
 */
export const ERROR_CODE_TO_HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  MFA_REQUIRED: 401,
  ENTITLEMENT_ERROR: 402,
  FORBIDDEN: 403,
  ACCOUNT_LOCKED: 403,
  MFA_ENROLL_REQUIRED: 403,
  EMAIL_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INSTANCE_PAUSED: 409,
  // P08 Unit U6c: the instance link/park routes' own 409 shapes - each
  // distinct from plain CONFLICT because each carries its own response
  // body (REGISTERED_LIMIT_REACHED has no extra details; NO_FREE_SLOT
  // carries `holders`; INVALID_STATE is the link/refresh illegal-transition
  // guard) - see instances.routes.ts.
  REGISTERED_LIMIT_REACHED: 409,
  NO_FREE_SLOT: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  // P05 Unit U3a: the per-user SSE connection cap (SSE_MAX_CONNECTIONS_PER_USER)
  // - a distinct code from RATE_LIMITED since this is a concurrent-connection
  // cap, not a request-rate limit, and carries no Retry-After semantics.
  TOO_MANY_CONNECTIONS: 429,
  // P04b Unit UB1b: the stub POST /v1/instances connect endpoint (P08 builds
  // real instance provisioning) - an honest "not built yet" response, never
  // a fabricated success.
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
  // P11 Unit U3: `POST /v1/instances/:id/messages`'s (`INSTANCE_UNLINKED`)
  // and `POST /v1/messages`'s (`IDEMPOTENCY_KEY_REUSED`) own 409 shapes.
  // `INSTANCE_UNLINKED` is a distinct code from the existing `INVALID_STATE`
  // (409, used for the link/refresh illegal-transition guard elsewhere) -
  // an unlinked instance is not an illegal STATE TRANSITION request, it is
  // "there is no session yet to send through", a different failure kind a
  // client needs to distinguish (e.g. to prompt "link this instance first"
  // vs. "wait and retry"). `IDEMPOTENCY_KEY_REUSED` is likewise its own code
  // (not bare `CONFLICT`) because its 409 carries a specific, actionable
  // meaning: the same key was sent with a DIFFERENT request body.
  INSTANCE_UNLINKED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  // P14 Unit U4: opted-out recipient - see ERROR_CODES's own comment above.
  RECIPIENT_OPTED_OUT: 422,
  // P15 Unit U5: SSRF-rejected webhook endpoint URL - see ERROR_CODES's own
  // comment above.
  WEBHOOK_URL_REJECTED: 422,
  // P16 Unit D: resume's own codes - see ERROR_CODES's own comment above.
  RESUME_REQUIRES_USER: 403,
  ACKNOWLEDGEMENT_REQUIRED: 422,
  // P20 Unit U4: see ERROR_CODES's own comment above.
  CONTACT_LIMIT_REACHED: 409,
  // P20 Unit U6: see ERROR_CODES's own comment above.
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // P23 Unit U5: see ERROR_CODES's own comment above.
  IDEMPOTENCY_KEY_REQUIRED: 400,
  // P23 Unit U6: see ERROR_CODES's own comment above.
  RESTAMP_COUNT_MISMATCH: 409,
  // P24 (groups): see ERROR_CODES's own comment above.
  GROUP_NOT_SENDABLE: 422,
};

export const errorCodeSchema = z.enum(ERROR_CODES);

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string(),
});

export type ErrorBody = z.infer<typeof errorBodySchema>;
