import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { restampInputSchema, broadcastMutationHeadersSchema } from '@wp/contracts';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute, type AuthPolicy } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { IdempotencyKeyRequiredError } from './broadcasts.errors.js';
import { restampBroadcast } from './restamp.service.js';

/**
 * restamp.routes.ts (P23 Unit U6, step 7) - `POST /v1/broadcasts/:id/
 * restamp`, the HTTP surface over `restamp.service.ts`. Same
 * `session_mfa`/mandatory-`Idempotency-Key`/always-`{kind:'user'}` actor
 * shape as `unresolved.routes.ts` (this action re-stamps jobs onto a NEW
 * session_epoch, i.e. resumes real sends on a possibly-relinked number - at
 * least as consequential as unresolved retry/discard).
 */

const RESTAMP_AUTH_POLICY: AuthPolicy = 'session_mfa';

const campaignIdParamSchema = z.object({ id: z.uuid() });

class RestampValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'RestampValidationError';
  }
}

function campaignIdFrom(req: FastifyRequest): string {
  const parsed = campaignIdParamSchema.safeParse(req.params);
  if (!parsed.success) {
    throw new RestampValidationError('A valid broadcast id path parameter is required.');
  }
  return parsed.data.id;
}

export interface RestampRoutesDeps {
  tenantDb: TenantDb;
  publishWakeForClient?: (clientId: string) => Promise<void>;
}

async function guardedRestamp(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped = err instanceof z.ZodError ? new RestampValidationError('Invalid request.') : err;
    sendError(reply, requestId, mapped);
  }
}

export function registerRestampRoutes(
  app: FastifyInstance,
  deps: RestampRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/broadcasts/:id/restamp',
    policy: RESTAMP_AUTH_POLICY,
    scope: 'broadcasts:restamp',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guardedRestamp(reply, requestId, async () => {
        const auth = req.auth!;
        const idempotencyKeyHeader = req.headers['idempotency-key'];
        if (typeof idempotencyKeyHeader !== 'string' || idempotencyKeyHeader.trim() === '') {
          throw new IdempotencyKeyRequiredError();
        }
        const headers = broadcastMutationHeadersSchema.parse(req.headers);
        const campaignId = campaignIdFrom(req);
        const body = restampInputSchema.parse(req.body);

        const result = await restampBroadcast(
          deps,
          { kind: 'user', userId: auth.userId },
          {
            clientId: auth.clientId,
            campaignId,
            confirmCount: body.confirmCount,
            idempotencyKey: headers['idempotency-key'],
          },
        );

        sendSuccess(reply, requestId, result, 200);
      });
    },
  });
}
