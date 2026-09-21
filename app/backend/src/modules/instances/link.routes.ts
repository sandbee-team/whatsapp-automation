import type { FastifyInstance } from 'fastify';
import { linkInstanceInputSchema } from '@wp/contracts';
import { provisioningRepo } from '../tenancy/index.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { beginPairing } from './service.js';
import {
  InstanceNotFoundError,
  guarded,
  instanceIdFrom,
  loadOwnedOrNotFound,
  withInstanceCtx,
  type InstancesRoutesDeps,
} from './instances.routes-support.js';

/**
 * link.routes.ts (2026-09-17, "QR takes 3-12s to appear" fix) - `POST
 * /v1/instances/:id/link`, split out of `instances.routes.ts` (already at
 * the 300-line max-lines cap - same sibling-module split idiom
 * `resume.routes.ts`/`delete.routes.ts` already established in this
 * directory) purely to make room for this fix's one new call:
 * `deps.publishDiscoveryWake?.()`, fired AFTER `withInstanceCtx`'s
 * transaction has committed.
 *
 * WHY AFTER COMMIT, NOT INSIDE THE TRANSACTION: same ordering rule
 * `engine/queue/wake.ts#publishWake`'s own doc comment states for the
 * send-loop wake - a subscriber waking up to a row it cannot yet see under
 * its own read (because the transaction that would make it visible has not
 * committed yet) is worse than a slightly-delayed wake. `beginPairing`
 * (this handler, above) commits via `withInstanceCtx`'s `deps.tenantDb.
 * withTenant` before this function returns, so the wake below always fires
 * after `beginPairingIntent`'s UPDATE (`db/queries/instance-begin-pairing.sql`)
 * is durable and visible to any worker's next discovery scan.
 *
 * WHY THIS IS A HINT, NEVER THE ONLY PATH: `roles/session-worker.ts`'s
 * existing 5000ms+/-2000ms jittered scan timer keeps running completely
 * unconditionally - `publishDiscoveryWake` only shortens the average wait
 * for the common case (see `engine/fleet/discovery-wake.ts`'s own module
 * doc for the full pub/sub-is-a-latency-optimisation-not-an-authority
 * rationale, mirroring `wake.ts`'s established shape exactly).
 */
export function registerLinkRoute(
  app: FastifyInstance,
  deps: InstancesRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/link',
    policy: 'session_mfa',
    scope: 'instances:link',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);
        linkInstanceInputSchema.parse(req.body);

        await withInstanceCtx(deps, auth.clientId, async (ctx, tx) => {
          await loadOwnedOrNotFound(ctx, instanceId);
          const ok = await beginPairing(ctx, { instanceId });
          if (!ok) throw new InstanceNotFoundError();

          await provisioningRepo.insertAuditLog(tx, {
            clientId: auth.clientId,
            actorType: 'user',
            actorUserId: auth.userId,
            action: 'instance.link_started',
            targetType: 'instance',
            targetId: instanceId,
          });
        });

        // Strictly after the transaction above has committed (module doc) -
        // same ordering `resume.ts#resumeInstance` uses for `publishWake`.
        // Awaited, not detached: `publishDiscoveryWake` itself swallows every
        // error internally (discovery-wake.ts's own try/catch), so this
        // never rejects and never meaningfully delays the 202 below - a
        // Redis PUBLISH is a single fast round trip, and a dropped wake is
        // exactly what the mandatory scan-interval poll survives.
        await deps.publishDiscoveryWake?.();

        sendSuccess(reply, requestId, { linkState: 'pairing' }, 202);
      });
    },
  });
}
