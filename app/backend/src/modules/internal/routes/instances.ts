import type { FastifyInstance } from 'fastify';
import { pauseInstanceInputSchema, staffResumeInstanceInputSchema } from '@wp/contracts';
import { humanResume, staffPause, setInstanceHealthStateGauge } from '../../pacing/index.js';
import { provisioningRepo } from '../../tenancy/index.js';
import { emit } from '../../events/index.js';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import {
  InternalAcknowledgementRequiredError,
  InternalInvalidStateError,
  InternalTargetNotFoundError,
} from './internal-errors.js';
import { registerStaffMutation } from './staff-route-shell.js';
import { registerInternalPacingRoutes } from './pacing.js';

/**
 * routes/instances.ts (P28 Unit U3b, step 5) - the staff INSTANCE-control
 * mutations: `POST /internal/v1/instances/:id/{pause,resume}`. The pacing-
 * relax override lives in the `pacing.ts` sibling (300-line cap split) and is
 * registered from this file's own `registerInternalInstanceRoutes`.
 *
 * `clientId` travels in the BODY, not the path (the contract's own doc
 * comment: an instance id alone is not tenant-scoped without a DB lookup the
 * contract layer cannot do). Every statement below therefore carries BOTH
 * `id = :instanceId AND client_id = :clientId`, and a row that does not
 * match both is a 404 - deliberately indistinguishable from "no such
 * instance", so a staff caller cannot probe which instance belongs to which
 * tenant (core invariant 4).
 *
 * SAFE MODE / SAFETY-COMPLIANCE, RESUME (test 11): a resume is only ever a
 * NAMED HUMAN's decision. Three independent layers enforce that here, and
 * none of them may be relaxed:
 *  1. the route is unreachable without a valid `X-Actor: staff:<uuid>` whose
 *     `staff_users` row is `active` - `system` or `api_key:<uuid>` is a 403
 *     from `resolveStaffActor`, BEFORE any read;
 *  2. `canStaff(role, 'instances.resume')` is re-checked server-side inside
 *     `withStaffMutation`, so a `support` role is a 403 too;
 *  3. `humanResume` (the ONLY paused-exit writer in the codebase) types its
 *     `actor` as `UserActor`, whose members are the two HUMAN kinds only -
 *     a system actor is not REPRESENTABLE at that call site.
 * On top of those, a `provider_restriction` pause requires an explicit
 * `acknowledgement: true` (422 `ACKNOWLEDGEMENT_REQUIRED` otherwise): staff
 * get NO shortcut past a restriction pause that a tenant would not get. That
 * is the whole point - "recover only through the provider's legitimate path,
 * initiated by a human who has acknowledged what happened".
 */

interface InstanceStateRow extends Record<string, unknown> {
  health_state: string;
  pause_reason: string | null;
}

/** Reads the instance's own current state under a row lock, scoped to BOTH ids - a non-matching row is a 404 (see module doc). */
async function lockInstanceOrThrow(
  tx: StaffMutationTx,
  clientId: string,
  instanceId: string,
): Promise<InstanceStateRow> {
  const result = await tx.query<InstanceStateRow>(
    `SELECT health_state, pause_reason FROM whatsapp_instances
      WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [instanceId, clientId],
  );
  const row = result.rows[0];
  if (!row) throw new InternalTargetNotFoundError('No such instance for this client.');
  return row;
}

function registerPauseRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: '/internal/v1/instances/:id/pause',
    scope: 'internal:instances:pause',
    action: 'instances.pause',
    bodySchema: pauseInstanceInputSchema,
    targetKind: 'instance',
    resolveTarget: (pathId, body) => ({ clientId: body.clientId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const current = await lockInstanceOrThrow(tx, ctx.clientId, ctx.pathId);

      if (current.health_state === 'paused') {
        // Already paused - an idempotent no-op. Critically, the existing
        // `pause_reason` is left ALONE: overwriting a `provider_restriction`
        // with `admin_action` would erase the record of why sending stopped.
        return {
          instanceId: ctx.pathId,
          healthState: 'paused',
          pauseReason: 'admin_action',
          changed: false,
        };
      }
      if (current.health_state !== 'connected' && current.health_state !== 'degraded') {
        throw new InternalInvalidStateError(
          `This instance is ${current.health_state}; only a connected or degraded instance can be paused.`,
        );
      }

      const { changed } = await staffPause(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        staffId: tx.actor.staffId,
      });

      if (changed) {
        // Deferred to AFTER commit - see `staff-pause.ts`'s own doc for why
        // setting this gauge inside the transaction would let it observe a
        // 'paused' state that has not actually committed yet. Mirrors the
        // resume route's own `tx.afterCommit(() => ctx.deps.publishWake(...))`.
        tx.afterCommit(() =>
          setInstanceHealthStateGauge({
            clientId: ctx.clientId,
            instanceId: ctx.pathId,
            healthState: 'paused',
          }),
        );
      }

      await provisioningRepo.insertAuditLog(tx, {
        clientId: ctx.clientId,
        actorType: 'staff',
        actorStaffId: tx.actor.staffId,
        action: 'instance.paused',
        targetType: 'instance',
        targetId: ctx.pathId,
        metadata: { pauseReason: 'admin_action' },
      });

      await notify(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        kind: 'instance_paused_by_staff',
        transitionId: String(tx.auditId),
        payload: { instanceId: ctx.pathId, pauseReason: 'admin_action' },
      });

      await emit(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        type: 'instance.paused',
        entityId: ctx.pathId,
        payload: {
          instanceId: ctx.pathId,
          pauseReason: 'admin_action',
          needsUserAction: false,
        },
        fanout: ['sse', 'webhook'],
      });

      return {
        instanceId: ctx.pathId,
        healthState: 'paused',
        pauseReason: 'admin_action',
        changed,
      };
    },
  });
}

function registerResumeRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: '/internal/v1/instances/:id/resume',
    scope: 'internal:instances:resume',
    action: 'instances.resume',
    // The ALIASED internal schema, never the bare `resumeInstanceInputSchema`
    // name: that one resolves to the TENANT resume contract (no `clientId`)
    // through `@wp/contracts`' barrel - see the internal schema's own
    // "NAME COLLISION" doc comment.
    bodySchema: staffResumeInstanceInputSchema,
    targetKind: 'instance',
    resolveTarget: (pathId, body) => ({ clientId: body.clientId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const current = await lockInstanceOrThrow(tx, ctx.clientId, ctx.pathId);

      if (current.health_state !== 'paused') {
        throw new InternalInvalidStateError('This instance is not currently paused.');
      }
      if (current.pause_reason === 'provider_restriction' && ctx.body.acknowledgement !== true) {
        // Staff get no shortcut past a restriction pause - see module doc.
        throw new InternalAcknowledgementRequiredError();
      }

      // The ONLY paused-exit writer, with a `staff_user` (human) actor.
      const { resumed } = await humanResume(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        actor: { type: 'staff_user', staffId: tx.actor.staffId },
      });

      await provisioningRepo.insertAuditLog(tx, {
        clientId: ctx.clientId,
        actorType: 'staff',
        actorStaffId: tx.actor.staffId,
        action: 'instance.resume',
        targetType: 'instance',
        targetId: ctx.pathId,
        metadata: {
          previousPauseReason: current.pause_reason,
          acknowledgement: ctx.body.acknowledgement ?? false,
        },
      });

      await notify(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        kind: 'instance_resumed_by_staff',
        transitionId: String(tx.auditId),
        payload: { instanceId: ctx.pathId },
      });

      // The SAME outbox event the tenant's own resume route emits
      // (`modules/instances/resume.ts`) - a tenant's dashboard/webhook must
      // not be able to tell a staff resume from its own by event shape.
      await emit(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        type: 'instance.resumed',
        entityId: ctx.pathId,
        payload: { instanceId: ctx.pathId, healthState: 'degraded' },
        fanout: ['sse', 'webhook'],
      });

      // A resume turns a zero-claim state into a claimable one, so it wakes -
      // strictly AFTER commit, never inside the transaction.
      tx.afterCommit(() => ctx.deps.publishWake(ctx.clientId, ctx.pathId));

      return { instanceId: ctx.pathId, healthState: 'degraded', resumed };
    },
  });
}

export function registerInternalInstanceRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerPauseRoute(app, deps, authDeps);
  registerResumeRoute(app, deps, authDeps);
  registerInternalPacingRoutes(app, deps, authDeps);
}
