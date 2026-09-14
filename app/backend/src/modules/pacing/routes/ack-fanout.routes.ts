import type { FastifyInstance } from 'fastify';
import { ackFanoutInputSchema } from '@wp/contracts';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { ackFanout, listPendingFanoutAcks } from './ack-fanout.js';

/**
 * ack-fanout.routes.ts (P14 Unit U7, step 8) - `POST /v1/pacing/fanout-acks`
 * and `GET /v1/pacing/fanout-acks/pending`. `policy: 'session'` (never
 * `'public'`, never a bare API-key path - this router has no API-key
 * authentication mechanism at all today, only the bearer session token
 * `route-policy.ts#authenticateRequest` validates, so `'session'` alone
 * already excludes every non-human caller) - the ack is a human decision per
 * ADR 0015 decision 4, matching `optout/restore.ts`'s own human-actor-only
 * discipline.
 */

export interface AckFanoutRoutesDeps {
  tenantDb: TenantDb;
  /** `engine/queue/wake.ts#publishWake`, pre-bound to a real Redis handle by the caller (`roles/api.ts` wiring - outside this unit's scope). */
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
}

export function registerAckFanoutRoutes(
  app: FastifyInstance,
  deps: AckFanoutRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/pacing/fanout-acks',
    policy: 'session',
    scope: 'pacing:fanout-ack',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const input = ackFanoutInputSchema.parse(req.body);
        const fingerprint = Buffer.from(input.fingerprint, 'hex');

        const result = await ackFanout(
          { tenantDb: deps.tenantDb, publishWake: deps.publishWake },
          {
            clientId: auth.clientId,
            actorUserId: auth.userId,
            localDate: input.localDate,
            fingerprint,
          },
        );

        sendSuccess(
          reply,
          requestId,
          {
            localDate: input.localDate,
            fingerprint: input.fingerprint,
            acked: result.acked,
          },
          200,
        );
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/pacing/fanout-acks/pending',
    policy: 'session',
    scope: 'pacing:fanout-ack:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const items = await listPendingFanoutAcks(deps.tenantDb, auth.clientId);
        sendSuccess(reply, requestId, { items }, 200);
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
