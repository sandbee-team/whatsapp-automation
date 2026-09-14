import type { FastifyInstance } from 'fastify';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { readQueueStatus, type QueueStatusResult } from './queue-status.repo.js';

/**
 * queue-status.routes.ts (P19 Unit U5, step 9) - `GET /v1/queue-status`, a
 * TENANT route (binding correction #8): `policy: 'session'`, scope
 * `queue:read`, tenant-scoped from `req.auth!.clientId` ONLY (never a
 * query/body field). Returns per-instance rows plus workspace totals from
 * `queue-status.repo.ts`.
 */

export interface QueueStatusRoutesDeps {
  tenantDb: TenantDb;
}

/**
 * Wire boundary: `spentTodayMinor` is PAISE, bigint in `queue-status.repo.ts`
 * - serialised here as a decimal STRING (never a JSON number: JSON.stringify
 * throws on a bigint, and a JS number cannot represent every bigint-range
 * amount exactly). Matches `queueStatusInstanceSchema`/
 * `queueStatusWorkspaceSchema` in `@wp/contracts`.
 */
function toWireResult(result: QueueStatusResult): {
  instances: Array<{
    instanceId: string;
    waiting: number;
    sentToday: number;
    failedToday: number;
    spentTodayMinor: string;
  }>;
  workspace: {
    waiting: number;
    sentToday: number;
    failedToday: number;
    spentTodayMinor: string;
  };
} {
  return {
    instances: result.instances.map((row) => ({
      ...row,
      spentTodayMinor: row.spentTodayMinor.toString(),
    })),
    workspace: {
      ...result.workspace,
      spentTodayMinor: result.workspace.spentTodayMinor.toString(),
    },
  };
}

export function registerQueueStatusRoutes(
  app: FastifyInstance,
  deps: QueueStatusRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/queue-status',
    policy: 'session',
    scope: 'queue:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const result = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          readQueueStatus(tx, auth.clientId),
        );
        sendSuccess(reply, requestId, toWireResult(result));
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}
