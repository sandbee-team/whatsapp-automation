import type { FastifyInstance } from 'fastify';
import { pacingOverrideInputSchema } from '@wp/contracts';
import { clampAdminRelax } from '@wp/domain';
import { insertAdminRelaxOverride } from '../../pacing/index.js';
import { loadInstanceLayers } from '../../../engine/pacing/admin-relax-layers.js';
import { updatePacingConfig } from '../../../engine/pacing/config-service.js';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { InternalValidationError } from '../internal-access.js';
import { InternalInvalidStateError, InternalTargetNotFoundError } from './internal-errors.js';
import { registerStaffMutation } from './staff-route-shell.js';

/**
 * routes/pacing.ts (P28 Unit U3b, step 5) -
 * `POST /internal/v1/instances/:id/pacing-override`, the staff pacing-RELAX
 * mutation (`pacing.relax`, SUPERADMIN only - `ops` and `support` are both
 * 403, enforced inside `withStaffMutation` via `canStaff`). Split out of
 * `instances.ts` for that file's own `max-lines: 300` cap and registered
 * from it.
 *
 * THIS IS THE ONE ROUTE THAT LOOSENS A SAFETY CONTROL, so it is fenced on
 * four independent sides and NONE of them may be relaxed to make a test or a
 * customer request pass:
 *
 *  1. `clampAdminRelax` runs FIRST, before any read or write. It clamps every
 *     field to the absolute platform bounds (`ABSOLUTE_DAILY_CEILING`,
 *     `ABSOLUTE_GAP_MIN_MS`, `ABSOLUTE_GROUP_DAILY_CEILING`) and REJECTS a
 *     missing/past/ >30-day expiry outright. What gets STORED is the clamped
 *     patch, never the requested one, and `clampedFields` in the response
 *     tells the operator exactly which numbers were overruled - a staff
 *     member must never be able to believe a cap applied that did not.
 *
 *  2. A `provider_restriction`-paused instance is REFUSED (409
 *     `INVALID_STATE`). This is core invariant 6 / safety-compliance, not
 *     ergonomics: relaxing pacing on a number the provider has just
 *     restricted is precisely a "mechanism whose purpose is to circumvent a
 *     provider restriction". The instance must be resumed through the
 *     legitimate acknowledged path first; only then can its pacing be
 *     discussed.
 *
 *  3. Expiry is MANDATORY (the contract requires `expiresAt`, and
 *     `clampAdminRelax` bounds it to 30 days). A relax is temporary,
 *     reasoned and audited - never permanent. `engine/pacing/
 *     admin-relax-expiry.ts` is what actually walks it back.
 *
 *  4. The write goes through `updatePacingConfig` (the ONE writer of
 *     `instance_pacing_state.eff_*`) with the FULL layer set reloaded from
 *     stored state via `loadInstanceLayers`, so `resolveEffective()` folds
 *     the override against the real system-profile ceiling and health band -
 *     the relax can only ever loosen within what those layers already allow.
 */

/** `clampAdminRelax` returns a `Partial<PacingLayer>`; the override row and the response both need it as a plain numeric record. */
function toNumericPatch(patch: Record<string, number | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

export function registerInternalPacingRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: '/internal/v1/instances/:id/pacing-override',
    scope: 'internal:instances:pacing-override',
    action: 'pacing.relax',
    bodySchema: pacingOverrideInputSchema,
    targetKind: 'instance',
    resolveTarget: (pathId, body) => ({ clientId: body.clientId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const nowMs = (ctx.deps.now ? ctx.deps.now() : new Date()).getTime();
      const expiresAtMs = Date.parse(ctx.body.expiresAt);

      // FENCE 1: clamp/validate BEFORE any read or write (module doc). A
      // rejected expiry or a non-positive field throws here, so nothing -
      // not even the override row - is written.
      //
      // `clampAdminRelax`'s three error classes are PURE DOMAIN errors with
      // no HTTP `code`, so they would otherwise map to a 500 through
      // `error-mapper.ts`'s unknown-throwable branch. They are all
      // caller-input faults (bad/absent/too-distant expiry, a non-positive
      // field), so they are re-raised as the 400 the contract promises -
      // never a 5xx, which would read as "our fault" in an operator's logs
      // and hide a plainly invalid request.
      let clamped: ReturnType<typeof clampAdminRelax>;
      try {
        clamped = clampAdminRelax({ patch: ctx.body.patch, expiresAtMs, nowMs });
      } catch (err) {
        throw new InternalValidationError(err instanceof Error ? err.message : 'Invalid relax.');
      }
      const clampedPatch = toNumericPatch(clamped.patch);

      const instance = await tx.query<{ health_state: string; pause_reason: string | null }>(
        `SELECT health_state, pause_reason FROM whatsapp_instances
          WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [ctx.pathId, ctx.clientId],
      );
      const row = instance.rows[0];
      if (!row) throw new InternalTargetNotFoundError('No such instance for this client.');

      // FENCE 2: never relax an instance the provider has restricted.
      if (row.pause_reason === 'provider_restriction') {
        throw new InternalInvalidStateError(
          'This instance is paused by a provider restriction; its pacing cannot be relaxed. ' +
            'Resume it through the acknowledged recovery path first.',
        );
      }

      const expiresAt = new Date(expiresAtMs);
      const overrideId = await insertAdminRelaxOverride(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        patch: clampedPatch,
        reason: ctx.body.reason,
        actorStaffId: tx.actor.staffId,
        expiresAt,
      });

      // FENCE 4: the ONE `eff_*` writer, with the full layer set reloaded
      // from stored state. `actorUserId` carries the STAFF id here - it is
      // `AdminOverride`'s only actor field (a domain type shared with the
      // tenant-facing layers) and `assertAdminRelaxValid` requires it
      // non-empty; the authoritative staff attribution is the
      // `actor_staff_id` column on the override row above and the
      // `staff_audit_log` row `withStaffMutation` already wrote.
      const layers = await loadInstanceLayers(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        adminOverride: {
          ...clampedPatch,
          actorUserId: tx.actor.staffId,
          reason: ctx.body.reason,
          expiresAt: expiresAtMs,
        },
      });

      await updatePacingConfig({
        sql: tx,
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        kind: 'admin_relax',
        reason: ctx.body.reason,
        layers,
        clock: { now: () => nowMs },
      });

      await notify(tx, {
        clientId: ctx.clientId,
        instanceId: ctx.pathId,
        kind: 'pacing_relaxed',
        transitionId: String(tx.auditId),
        payload: {
          instanceId: ctx.pathId,
          expiresAt: ctx.body.expiresAt,
          fields: Object.keys(clampedPatch),
        },
      });

      return {
        instanceId: ctx.pathId,
        overrideId,
        appliedPatch: clampedPatch,
        clampedFields: clamped.clampedFields,
        expiresAt: ctx.body.expiresAt,
      };
    },
  });
}
