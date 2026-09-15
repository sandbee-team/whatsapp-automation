import type { FastifyInstance } from 'fastify';
import { provisioningRepo } from '../tenancy/index.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import * as repo from './repo.js';
import {
  InstanceNotFoundError,
  InvalidStateError,
  guarded,
  instanceIdFrom,
  loadOwnedOrNotFound,
  withInstanceCtx,
  type InstancesRoutesDeps,
} from './instances.routes-support.js';

/**
 * delete.routes.ts (2026-09-15 founder request) - `DELETE
 * /v1/instances/:id`, kept out of `instances.routes.ts` (which sits at the
 * 300-line max-lines cap already) rather than folded in - same sibling-module
 * split idiom `resume.routes.ts` already established for `POST
 * .../resume`. Reuses the same `InstancesRoutesDeps` + `guarded`/
 * `withInstanceCtx`/`loadOwnedOrNotFound` helpers `park`/`online` already use
 * in `instances.routes.ts` (no request body to validate here, so no
 * `z.ZodError` mapping is needed - unlike `resume.routes.ts`, which parses
 * one).
 *
 * BACKSTORY: a client's WhatsApp number can end up dead weight two ways - it
 * gets unlinked on the WhatsApp side (removed under Linked Devices) or
 * pairing never completes - and until now there was no way to remove it from
 * a workspace, so it sat there forever still counting against
 * `plan_limits.max_registered_instances` (instance-count-registered.sql
 * confirmed to already filter `deleted_at IS NULL` - see that file's own
 * header for the read side of this fix). A soft-delete repo function
 * (`repo.softDelete` / instance-soft-delete.sql) has existed since P08 but
 * had ZERO callers anywhere in either backend - this route is the wiring,
 * not a new mechanism.
 *
 * SOFT DELETE ONLY, NEVER A HARD DELETE: `wp_app` has no DELETE grant on
 * `whatsapp_instances` at all (instance-soft-delete.sql's own header,
 * migration 0023 ITEM 4's deliberate omission) and 13 other tables carry FKs
 * to this one with NO `ON DELETE CASCADE` declared anywhere (migration 0036
 * line 65) - a forced hard DELETE would simply raise a foreign-key
 * violation. `repo.softDelete` only ever sets `deleted_at = now()` +
 * `desired_state = 'offline'`, same one-audited-write discipline every other
 * tenant-action write in this module follows.
 *
 * STATE GUARD: a `linked` instance (whatever its `health_state` - connected,
 * degraded, or paused-while-still-linked) is refused with 409
 * `INVALID_STATE` - the same typed error the link/refresh route already
 * uses in `instances.routes.ts`, not a new error shape. Deleting is for the
 * two scenarios above, where `link_state` is already `'unlinked'` or stuck
 * in `'pairing'`; a still-`linked` instance must be unlinked/parked first so
 * an operator can never silently destroy a live, sending number.
 */
export function registerDeleteInstanceRoute(
  app: FastifyInstance,
  deps: InstancesRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'DELETE',
    path: '/v1/instances/:id',
    policy: 'session_mfa',
    scope: 'instances:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);

        await withInstanceCtx(deps, auth.clientId, async (ctx, tx) => {
          const status = await loadOwnedOrNotFound(ctx, instanceId);

          if (status.linkState === 'linked') {
            throw new InvalidStateError(
              "This number is still linked. Unlink it (remove it under WhatsApp's Linked " +
                'Devices, or park it) before deleting.',
            );
          }

          const ok = await repo.softDelete(ctx, instanceId);
          if (!ok) throw new InstanceNotFoundError();

          await provisioningRepo.insertAuditLog(tx, {
            clientId: auth.clientId,
            actorType: 'user',
            actorUserId: auth.userId,
            action: 'instance.deleted',
            targetType: 'instance',
            targetId: instanceId,
          });
        });

        sendSuccess(reply, requestId, { deleted: true });
      });
    },
  });
}
