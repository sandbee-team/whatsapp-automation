import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resumeInstanceInputSchema } from '@wp/contracts';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { resumeInstance } from './resume.js';
import { ValidationMappedError } from './instances.routes-support.js';

/**
 * resume.routes.ts (P16 Unit D, step 8) - `POST /v1/instances/:id/resume`,
 * kept out of `instances.routes.ts` (which sits at the 300-line max-lines
 * cap already) rather than folded in - same sibling-module split idiom the
 * mechanical conventions call for. `policy: 'session_mfa'` (the strictest
 * existing policy, matching `/link` and `/online`/`/park` - a human-only
 * action per the task) - today's HTTP surface has no API-key authentication
 * path at all, so every caller reaching this handler is already a
 * `{type:'user'}` actor; `resume.ts#resumeInstance`'s own runtime actor
 * guard is the structural, defence-in-depth enforcement for a future
 * API-key/system caller, not this route's job to duplicate.
 */

export interface ResumeRoutesDeps {
  tenantDb: TenantDb;
  /** `engine/queue/wake.ts#publishWake`, pre-bound to a real Redis handle by the caller (`roles/api.ts` wiring). */
  publishWake: (clientId: string, instanceId: string) => Promise<void> | void;
}

export function registerResumeRoute(
  app: FastifyInstance,
  deps: ResumeRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/resume',
    policy: 'session_mfa',
    scope: 'instances:resume',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const instanceId = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const input = resumeInstanceInputSchema.parse(req.body ?? {});

        const result = await resumeInstance(
          { tenantDb: deps.tenantDb, publishWake: deps.publishWake },
          {
            clientId: auth.clientId,
            instanceId,
            actor: { type: 'user', userId: auth.userId },
            reason: input.reason,
            acknowledgement: input.acknowledgement,
          },
        );

        sendSuccess(reply, requestId, { healthState: result.healthState });
      } catch (err) {
        const mapped =
          err instanceof z.ZodError ? new ValidationMappedError('Invalid request body.') : err;
        sendError(reply, requestId, mapped);
      }
    },
  });
}
