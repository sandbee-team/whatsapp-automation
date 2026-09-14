import type { FastifyInstance } from 'fastify';
import {
  createMessageHeadersSchema,
  createMessageInputSchema,
  type CreateMessageInput,
} from '@wp/contracts';
import { touchLastUsedAt } from '../api-keys/index.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import { requireCanSendForPrincipal } from '../../platform/http/guards.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { createMessage } from './messages.service.js';
import {
  enforceApiKeyRateLimitIfPresent,
  guarded,
  instanceIdFrom,
  principalFrom,
  recipientColumnsFor,
  type MessagesRoutesDeps,
} from './messages.routes-support.js';

/**
 * messages.routes.ts (P11 Unit U3; go-live U4 extends the policy to
 * `session_or_api_key`) - `POST /v1/messages`, the send-path MVP's enqueue
 * route (blueprint Flow 1). Durable-first (core invariant 1): this handler
 * never sends anything, it only ever calls `messages.service.ts#createMessage`,
 * which writes ONE durable job row (or replays an existing one on a genuine
 * idempotency-key retry) and returns.
 *
 * Go-live U4 (founder decision 2026-09-14): the acting principal is either a
 * human session (still the FULL `session_mfa` MFA check - `route-policy.ts`'s
 * `session_or_api_key` policy never downgrades that) or an api_key
 * (`req.apiKeyAuth`, resolved via `principalFrom`). An api_key principal's
 * rate limit is consumed FIRST, before the entitlement/enqueue work below -
 * `enforceApiKeyRateLimitIfPresent` throws `RateLimitedError` on deny, mapped
 * by `guarded()`'s existing `sendError` to 429 + `Retry-After`. The
 * throttled `touchLastUsedAt` fires WITHOUT awaiting, strictly after a
 * successful enqueue - a failure there must never fail the send (see its own
 * `.catch` below).
 *
 * The entitlement gate runs BEFORE any instance-state or queue-depth check -
 * the same ordering `instances.routes.ts`'s `requireCanConnect` uses.
 */

export type { MessagesRoutesDeps } from './messages.routes-support.js';

function parseScheduledAt(input: CreateMessageInput): Date | null {
  return input.scheduledAt ? new Date(input.scheduledAt) : null;
}

export function registerMessagesRoutes(
  app: FastifyInstance,
  deps: MessagesRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/messages',
    policy: 'session_or_api_key',
    scope: 'messages:create',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const principal = principalFrom(req);
        await enforceApiKeyRateLimitIfPresent(deps, principal);
        await requireCanSendForPrincipal(deps, {
          clientId: principal.clientId,
          userId: principal.actorUserId,
        });
        const instanceId = instanceIdFrom(req);
        const headers = createMessageHeadersSchema.parse(req.headers);
        const input = createMessageInputSchema.parse(req.body);

        const result = await createMessage(
          deps.tenantDb,
          {
            clientId: principal.clientId,
            instanceId,
            idempotencyKey: headers['idempotency-key'],
            requestBody: req.body as Record<string, unknown>,
            recipient: recipientColumnsFor(input.recipient),
            // The stored `message_jobs.payload` carries `kind` alongside the
            // contract's own payload fields - `payloadKindFor` (messages.
            // media-resolve.ts) maps THIS `kind` down to the coarse DB
            // `payload_kind` (ADR 0052 S7.1), but the fine kind must still be
            // readable from the job row itself: `dispatch.ts`'s
            // `toWaMessagePayload` reads `payload.kind` to pick the image vs.
            // document transport arm, and neither `message_jobs.payload_kind`
            // (two-valued) nor `input.kind` alone (never persisted on its
            // own) can answer that on its own.
            payload: { kind: input.kind, ...input.payload },
            payloadKind: input.kind,
            priority: input.priority,
            scheduledAt: parseScheduledAt(input),
            actorUserId: principal.actorUserId,
            // Always 'api_send' for this HTTP route - never read from the
            // request body (see CreateMessageServiceInput's own doc comment;
            // scripts/check-send-origin.ts clause (b) bans a client-settable
            // `origin` field on any DTO).
            sendOrigin: 'api_send',
          },
          { keyProvider: deps.keyProvider },
        );

        if (principal.apiKeyId) {
          // Fire-and-forget (see module doc comment): a failure here must
          // never fail the send that already committed above.
          void deps.tenantDb
            .withTenant(principal.clientId, (tx) =>
              touchLastUsedAt(tx, principal.clientId, principal.apiKeyId!),
            )
            .catch(() => undefined);
        }

        const status = result.warning ? 202 : 201;
        sendSuccess(
          reply,
          requestId,
          result.warning
            ? { id: result.id, status: result.status, warning: result.warning }
            : { id: result.id, status: result.status },
          status,
        );
      });
    },
  });
}
