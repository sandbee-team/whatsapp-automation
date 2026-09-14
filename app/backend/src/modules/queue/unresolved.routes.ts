import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unresolvedActionHeadersSchema } from '@wp/contracts';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute, type AuthPolicy } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { z } from 'zod';
import type { RepairedSendSink } from './repaired-send-sink.js';
import { discardUnresolved, retryUnresolved } from './unresolved.service.js';

/**
 * unresolved.routes.ts (P12 Unit U5, step 8) - `POST /v1/messages/:id/
 * unresolved/retry` and `.../discard`, the HTTP surface over
 * `unresolved.service.ts`. Both routes ALWAYS construct `{ kind: 'user',
 * userId: req.auth.userId }` - see `unresolved.service.ts`'s own doc
 * comment for why no other actor kind can ever reach this route today.
 *
 * AUTH POLICY: `session_mfa`, not plain `session`. This action can send a
 * real message to a real person (Retry) or abandon one (Discard) - the
 * same "an authenticated human, MFA-verified" bar `instances.routes.ts`'s
 * resume-a-restricted-instance route sets (ADR 0013 constraint 6's
 * neighbouring precedent), chosen deliberately over `session` because both
 * outcomes here are as consequential as a resume: Retry can duplicate a
 * real WhatsApp send, Discard can permanently abandon one. `registerRoute`
 * throws at boot if either `policy` or `scope` is missing - there is no
 * second registration path.
 */

const UNRESOLVED_AUTH_POLICY: AuthPolicy = 'session_mfa';

const jobIdParamSchema = z.object({ id: z.uuid() });

class UnresolvedValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedValidationError';
  }
}

function jobPublicIdFrom(req: FastifyRequest): string {
  const parsed = jobIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new UnresolvedValidationError('A valid message id path parameter is required.');
  }
  return parsed.data.id;
}

export interface UnresolvedRoutesDeps {
  tenantDb: TenantDb;
  sink: Pick<RepairedSendSink, 'onReconciledLost'>;
  /** ADR 0038 S5 - the PRIMARY in-transaction refund, threaded through to `retryUnresolved`. */
  refundSend?: (
    tx: TenantQueryable,
    input: { clientId: string; attemptId: string },
  ) => Promise<unknown>;
}

async function guardedUnresolved(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped =
      err instanceof z.ZodError ? new UnresolvedValidationError('Invalid request.') : err;
    sendError(reply, requestId, mapped);
  }
}

export function registerUnresolvedRoutes(
  app: FastifyInstance,
  deps: UnresolvedRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/messages/:id/unresolved/retry',
    policy: UNRESOLVED_AUTH_POLICY,
    scope: 'messages:unresolved:retry',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guardedUnresolved(reply, requestId, async () => {
        const auth = req.auth!;
        const headers = unresolvedActionHeadersSchema.parse(req.headers);
        const jobPublicId = jobPublicIdFrom(req);

        const result = await retryUnresolved(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, jobPublicId, idempotencyKey: headers['idempotency-key'] },
        );

        sendSuccess(reply, requestId, { id: result.publicId, status: result.status }, 200);
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/messages/:id/unresolved/discard',
    policy: UNRESOLVED_AUTH_POLICY,
    scope: 'messages:unresolved:discard',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guardedUnresolved(reply, requestId, async () => {
        const auth = req.auth!;
        const headers = unresolvedActionHeadersSchema.parse(req.headers);
        const jobPublicId = jobPublicIdFrom(req);

        const result = await discardUnresolved(
          deps,
          { kind: 'user', userId: auth.userId },
          { clientId: auth.clientId, jobPublicId, idempotencyKey: headers['idempotency-key'] },
        );

        sendSuccess(reply, requestId, { id: result.publicId, status: result.status }, 200);
      });
    },
  });
}
