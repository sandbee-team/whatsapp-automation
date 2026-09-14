import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantDb, TenantQueryable } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import type { RateLimiter } from '../../platform/http/rate-limit.js';
import { RateLimitedError, sendError } from '../../platform/http/error-mapper.js';
import type { GuardDeps } from '../../platform/http/guards.js';
import { consumeApiKeyRateLimit } from '../api-keys/index.js';

/**
 * messages.routes-support.ts (P11 Unit U3) - typed error classes + small
 * shared helpers `messages.routes.ts` uses, split out for max-lines
 * discipline (the `instances.routes-support.ts` idiom). Not a public
 * module surface (not exported from `index.ts`).
 *
 * INSTANCE ID: `createMessageContract`'s fixed shape (U1, `packages/
 * contracts/src/messages.ts`) is a FLAT `POST /v1/messages` with no
 * `instanceId` in the body - deliberately left to this unit. Modelled here
 * as a REQUIRED query-string parameter (`?instanceId=...`), the same
 * "route-local zod schema, not part of the shared oRPC contract" shape
 * `modules/realtime/routes.ts`'s `instanceIdsQuerySchema` already
 * establishes for a param that belongs to the transport, not the payload
 * contract.
 */

export const messageQuerySchema = z.object({ instanceId: z.uuid() });

export function instanceIdFrom(req: FastifyRequest): string {
  const parsed = messageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw new ValidationMappedError('A valid instanceId query parameter is required.');
  }
  return parsed.data.instanceId;
}

/** Splits `recipientSchema`'s validated string into the two columns `message_jobs` needs - a `@g.us` JID has no E.164 number (mj_recipient_shape). */
export function recipientColumnsFor(recipient: string): { jid: string; e164: string | null } {
  if (recipient.endsWith('@g.us')) {
    return { jid: recipient, e164: null };
  }
  return { jid: `${recipient.replace(/^\+/u, '')}@s.whatsapp.net`, e164: recipient };
}

export class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

export interface MessagesRoutesDeps extends GuardDeps {
  tenantDb: TenantDb;
  /** The `optout-pepper` KEK provider - threaded straight into `createMessage`'s own `keyProvider` dep (see that function's doc comment). */
  keyProvider: KeyProvider;
  /**
   * Go-live U4: the shared rate limiter backing `consumeApiKeyRateLimit` for
   * an api_key principal on this route. Optional so every existing test
   * harness that never wires an api-key principal keeps compiling unchanged;
   * a route that DOES receive `req.apiKeyAuth` with no `rateLimiter` wired
   * fails closed (see `messages.routes.ts`'s own call site).
   */
  rateLimiter?: RateLimiter;
}

/**
 * Go-live U4 (founder decision 2026-09-14): the acting principal for
 * `session_or_api_key` - either the api_key populated by `route-policy.ts`'s
 * key-authenticated branch, or the human session (`session_mfa`'s existing
 * full MFA check already ran either way, per that policy's own binding
 * semantics). Resolved as ONE shape here so the rest of the handler never
 * branches on which kind of caller this is beyond this one call.
 */
export interface SendingPrincipal {
  clientId: string;
  /** The acting user id for audit/`message_jobs.created_by_user_id`-shaped columns - `createdByUserId` for an api_key, `userId` for a session. */
  actorUserId: string;
  apiKeyId?: string;
}

export function principalFrom(req: FastifyRequest): SendingPrincipal {
  if (req.apiKeyAuth) {
    return {
      clientId: req.apiKeyAuth.clientId,
      actorUserId: req.apiKeyAuth.createdByUserId,
      apiKeyId: req.apiKeyAuth.apiKeyId,
    };
  }
  const auth = req.auth!;
  return { clientId: auth.clientId, actorUserId: auth.userId };
}

/**
 * Consumes the api-key rate limit FIRST (before any entitlement/enqueue
 * work) for an api_key principal only - a session principal never carries a
 * per-key budget. Throws `RateLimitedError` on deny so the handler's own
 * `guarded()` maps it to 429 + `Retry-After` (see `error-mapper.ts`'s
 * existing `RateLimitedError` handling - no new mapping needed here).
 */
export async function enforceApiKeyRateLimitIfPresent(
  deps: MessagesRoutesDeps,
  principal: SendingPrincipal,
): Promise<void> {
  if (!principal.apiKeyId) return;
  if (!deps.rateLimiter) {
    // Fail closed (core invariant 2): a route that can receive an api_key
    // principal but was never wired a limiter must never let it through
    // unmetered.
    throw new RateLimitedError({
      allowed: false,
      retryAfterMs: 1000,
      limit: 0,
      remaining: 0,
      resetMs: 0,
    });
  }
  const result = await consumeApiKeyRateLimit(deps.rateLimiter, {
    apiKeyId: principal.apiKeyId,
    clientId: principal.clientId,
  });
  if (!result.allowed) {
    throw new RateLimitedError(result);
  }
}

/** Same "minimal port, real pool underneath" shape `instances.routes-support.ts`'s `sqlFor` documents - `entitlementCtx.pool` is a real `pg.Pool`. */
export function sqlFor(deps: MessagesRoutesDeps): TenantQueryable {
  return deps.entitlementCtx.pool as unknown as TenantQueryable;
}

export async function guarded(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped =
      err instanceof z.ZodError ? new ValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}
