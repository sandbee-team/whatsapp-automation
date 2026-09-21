import type { FastifyInstance } from 'fastify';
import { createInstanceInputSchema } from '@wp/contracts';
import { PARKED_COPY, PAIRING_MAX_ATTEMPTS } from '@wp/domain';
import { provisioningRepo } from '../tenancy/index.js';
import { provisionInstancePacingState } from '../../engine/pacing/provision.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import { requireCanConnect } from '../../platform/http/guards.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import * as repo from './repo.js';
import * as reads from './instance-reads.repo.js';
import { setOnlineWithSlotCheck, type OnlineSlotPool } from './instance-online-slot.repo.js';
import {
  InstanceNotFoundError,
  InvalidStateError,
  NoFreeSlotError,
  RegisteredLimitReachedError,
  guarded,
  instanceIdFrom,
  loadOwnedOrNotFound,
  maskedOrNull,
  withInstanceCtx,
  type InstancesRoutesDeps,
} from './instances.routes-support.js';

/**
 * instances.routes.ts (P08 Unit U6c) - the instance link/park routes. Typed
 * errors and the shared helpers live in `instances.routes-support.ts`
 * (max-lines discipline). `DELETE /v1/instances/:id` (2026-09-15 founder
 * request) and `POST /v1/instances/:id/link` (2026-09-17, moved out to make
 * room for the discovery-wake call) are SIBLING files, `delete.routes.ts`/
 * `link.routes.ts` - this file already sits at the 300-line max-lines cap,
 * same split rationale `resume.routes.ts`'s own header documents for
 * `POST .../resume`.
 *
 * Every `:id` route scopes ownership by `id + clientId` - a foreign or absent
 * instance id returns 404 NOT_FOUND, never a 403-with-existence leak (tenant
 * isolation, core invariant 4).
 *
 * `desired_state` only ever changes via `repo.setDesiredState`, each call
 * paired with ONE audited `audit_logs` row (actor `'user'` + `actorUserId`).
 *
 * The full E.164 phone number NEVER leaves this file: every response that
 * carries a number runs it through `@wp/domain`'s `maskPhoneE164` first.
 *
 * EVERY handler runs its reads AND writes inside a tenant transaction
 * (`withInstanceCtx`, or `tenantDb.withTenant` directly). Mandatory, not
 * stylistic: these tables are FORCE-RLS and the production roles have no
 * BYPASSRLS, so a query without `app.client_id` reads zero rows and an
 * `audit_logs` INSERT raises 42501. See `withInstanceCtx`'s own doc.
 */

export type { InstancesRoutesDeps } from './instances.routes-support.js';

export function registerInstancesRoutes(
  app: FastifyInstance,
  deps: InstancesRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances',
    policy: 'session_mfa',
    scope: 'instances:create',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        await requireCanConnect(deps, req);
        const auth = req.auth!;
        const input = createInstanceInputSchema.parse(req.body);

        // FINDING 7 FIX (P13 C1 review): one transaction for create +
        // provision + audit. 2026-09-14: the plan-limit READS moved in here
        // too - on a bare pool they returned zero rows under `wp_app`, so
        // `maxRegistered` became 0 and every create would have 403'd in
        // production. It also makes the cap check and the insert atomic.
        const id = await deps.tenantDb.withTenant(auth.clientId, async (tx) => {
          const ctx = { clientId: auth.clientId, sql: tx };
          const planLimits = await reads.readPlanLimits(ctx);
          const registeredCount = await reads.countRegisteredInstances(ctx);
          const maxRegistered = planLimits?.maxRegisteredInstances ?? 0;
          if (registeredCount >= maxRegistered) {
            throw new RegisteredLimitReachedError();
          }

          const newId = await repo.createInstance(
            { clientId: auth.clientId, sql: tx },
            { label: input.label },
          );
          await provisionInstancePacingState(tx, {
            clientId: auth.clientId,
            instanceId: newId,
          });
          await provisioningRepo.insertAuditLog(tx, {
            clientId: auth.clientId,
            actorType: 'user',
            actorUserId: auth.userId,
            action: 'instance.created',
            targetType: 'instance',
            targetId: newId,
          });
          return newId;
        });

        sendSuccess(
          reply,
          requestId,
          {
            id,
            label: input.label,
            linkState: 'unlinked',
            healthState: 'never_linked',
            desiredState: 'offline',
          },
          201,
        );
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/link/refresh',
    policy: 'session_mfa',
    scope: 'instances:link',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);
        await withInstanceCtx(deps, auth.clientId, async (ctx, tx) => {
          const status = await loadOwnedOrNotFound(ctx, instanceId);
          const legal =
            status.linkState === 'pairing' || status.userActionReason === 'PAIRING_EXPIRED';
          if (!legal) {
            throw new InvalidStateError(
              'A pairing window can only be refreshed while pairing or after it has expired.',
            );
          }

          const ok = await repo.resetPairingWindow(ctx, instanceId);
          if (!ok) throw new InstanceNotFoundError();

          await provisioningRepo.insertAuditLog(tx, {
            clientId: auth.clientId,
            actorType: 'user',
            actorUserId: auth.userId,
            action: 'instance.link_refreshed',
            targetType: 'instance',
            targetId: instanceId,
          });
        });

        sendSuccess(reply, requestId, { challenge: null, linkState: 'pairing' });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/instances/:id/link-status',
    policy: 'session',
    scope: 'instances:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);
        const status = await withInstanceCtx(deps, auth.clientId, (ctx) =>
          loadOwnedOrNotFound(ctx, instanceId),
        );
        sendSuccess(reply, requestId, {
          linkState: status.linkState,
          healthState: status.healthState,
          desiredState: status.desiredState,
          needsUserAction: status.needsUserAction,
          userActionReason: status.userActionReason,
          attemptsLeft: Math.max(0, PAIRING_MAX_ATTEMPTS - status.qrAttempts),
          maskedNumber: maskedOrNull(status.phoneE164),
        });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/online',
    policy: 'session_mfa',
    scope: 'instances:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);
        await withInstanceCtx(deps, auth.clientId, (ctx) => loadOwnedOrNotFound(ctx, instanceId));

        // FIX 3 (P08 E3): `setOnlineWithSlotCheck` runs the count and the set
        // in ONE transaction, serialised per-client by `SELECT ... FOR
        // UPDATE`, closing the two-concurrent-online race. It sets
        // `app.client_id` itself, so it is already RLS-correct and stays
        // outside the wrapper above.
        const result = await setOnlineWithSlotCheck(
          deps.entitlementCtx.pool as unknown as OnlineSlotPool,
          { clientId: auth.clientId, instanceId },
        );
        if (!result.ok && result.reason === 'no_free_slot') {
          throw new NoFreeSlotError(
            result.holders.map((holder) => ({
              instanceId: holder.instanceId,
              label: holder.label,
              maskedNumber: maskedOrNull(holder.phoneE164),
            })),
          );
        }
        if (!result.ok && result.reason === 'not_found') {
          throw new InstanceNotFoundError();
        }

        // FIX ROUND 2 FIX 2: only audit an ACTUAL transition - a repeated
        // idempotent re-online call (result.changed === false) is a no-op
        // and must never append another 'instance.online' audit row.
        if (result.ok && result.changed) {
          await deps.tenantDb.withTenant(auth.clientId, (tx) =>
            provisioningRepo.insertAuditLog(tx, {
              clientId: auth.clientId,
              actorType: 'user',
              actorUserId: auth.userId,
              action: 'instance.online',
              targetType: 'instance',
              targetId: instanceId,
            }),
          );
        }

        sendSuccess(reply, requestId, { desiredState: 'online' });
      });
    },
  });

  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/instances/:id/park',
    policy: 'session_mfa',
    scope: 'instances:manage',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      await guarded(reply, requestId, async () => {
        const auth = req.auth!;
        const instanceId = instanceIdFrom(req);
        await withInstanceCtx(deps, auth.clientId, async (ctx, tx) => {
          await loadOwnedOrNotFound(ctx, instanceId);
          const ok = await repo.setDesiredState(ctx, instanceId, 'offline');
          if (!ok) throw new InstanceNotFoundError();

          await provisioningRepo.insertAuditLog(tx, {
            clientId: auth.clientId,
            actorType: 'user',
            actorUserId: auth.userId,
            action: 'instance.parked',
            targetType: 'instance',
            targetId: instanceId,
          });
        });

        sendSuccess(reply, requestId, { desiredState: 'offline', parkedCopy: PARKED_COPY });
      });
    },
  });
}
