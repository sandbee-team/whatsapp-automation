import type { FastifyInstance } from 'fastify';
import { setClientLimitsInputSchema, type ClientLimitOverride } from '@wp/contracts';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { registerStaffMutation } from './staff-route-shell.js';

/**
 * routes/clients-limits.ts (P28 Unit U3b, step 5) -
 * `PUT /internal/v1/clients/:id/limits`, split out of `clients.ts` for that
 * file's own `max-lines: 300` cap and registered from it (so `index.ts`
 * still has exactly one call per area).
 *
 * SOFT CLEAR, NOT A DELETE: `wp_app` has SELECT/INSERT/UPDATE on
 * `client_limit_overrides` and deliberately NO DELETE grant (migration
 * 0030), so `limitValue: null` writes `limit_value = NULL` together with
 * `expires_at = now()` instead of removing the row. Both halves matter:
 * every reader (`modules/contacts/contacts-limits.ts#
 * resolveEffectiveMaxContacts`, `modules/broadcasts/limits.ts#
 * resolveEffectiveMaxBroadcastRecipients`, `db/queries/
 * instance-plan-limits.sql`) resolves the override through
 * `COALESCE(override, plan_limits.<key>)` with an
 * `(expires_at IS NULL OR expires_at > now())` guard, so a NULL value AND an
 * already-elapsed expiry both fall back to the plan value - belt and braces,
 * since a future reader that forgets one of the two guards still resolves
 * correctly through the other.
 *
 * The upsert is keyed on the table's own PK `(client_id, limit_key)`, so a
 * repeat call for the same key REPLACES the override rather than accumulating
 * rows (core invariant 3: idempotency at the storage layer).
 */

async function upsertOverride(
  tx: StaffMutationTx,
  input: {
    clientId: string;
    staffId: string;
    reason: string;
    override: ClientLimitOverride;
  },
): Promise<void> {
  const isClear = input.override.limitValue === null;
  await tx.query(
    `INSERT INTO client_limit_overrides
       (client_id, limit_key, limit_value, reason, actor_staff_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, limit_key) DO UPDATE SET limit_value = EXCLUDED.limit_value,
           reason = EXCLUDED.reason,
           actor_staff_id = EXCLUDED.actor_staff_id,
           expires_at = EXCLUDED.expires_at
     -- client_id = $1 (the INSERT's own first column; the ON CONFLICT target
     -- is the table's PK (client_id, limit_key), so this statement can only
     -- ever touch the one row belonging to $1)`,
    [
      input.clientId,
      input.override.limitKey,
      input.override.limitValue,
      input.reason,
      input.staffId,
      // A clear stamps `expires_at = now()` (already elapsed by the time any
      // reader looks) - see module doc for why both halves are written.
      isClear ? new Date() : (input.override.expiresAt ?? null),
    ],
  );
}

export function registerInternalClientLimitsRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'PUT',
    path: '/internal/v1/clients/:id/limits',
    scope: 'internal:clients:limits',
    action: 'clients.limits',
    bodySchema: setClientLimitsInputSchema,
    targetKind: 'client',
    resolveTarget: (pathId) => ({ clientId: pathId, targetRef: pathId }),
    run: async (tx, ctx) => {
      for (const override of ctx.body.overrides) {
        await upsertOverride(tx, {
          clientId: ctx.clientId,
          staffId: tx.actor.staffId,
          reason: ctx.body.reason,
          override,
        });
      }

      // ONE notification per CALL, never per override - a staff member
      // adjusting three caps in one request made one change from the
      // tenant's point of view.
      await notify(tx, {
        clientId: ctx.clientId,
        kind: 'limits_changed',
        transitionId: String(tx.auditId),
        payload: { limitKeys: ctx.body.overrides.map((override) => override.limitKey) },
      });

      return { clientId: ctx.clientId, overrides: ctx.body.overrides };
    },
  });
}
