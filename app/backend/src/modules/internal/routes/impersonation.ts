import type { FastifyInstance } from 'fastify';
import { grantImpersonationInputSchema } from '@wp/contracts';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { InternalValidationError } from '../internal-access.js';
import { InternalTargetNotFoundError } from './internal-errors.js';
import { registerStaffMutation } from './staff-route-shell.js';
import { registerImpersonationMintRoute } from './impersonation-mint.js';
import { registerImpersonationElevateRoute } from './impersonation-elevate.js';
import {
  registerImpersonationRevokeRoute,
  registerImpersonationListRoute,
} from './impersonation-revoke-list.js';

/**
 * routes/impersonation.ts (P28 Unit U3c) - `POST /internal/v1/clients/:id/
 * impersonation`, the GRANT step. Every grant starts at `metadata_only`
 * scope (the contract's own default) - `elevate` (impersonation-elevate.ts)
 * is the ONLY way to reach `with_message_bodies`. The mint/elevate/revoke/
 * list handlers live in the `impersonation-mint.ts`/`impersonation-
 * elevate.ts`/`impersonation-revoke-list.ts` siblings (300-line cap split:
 * those four hand-roll their own gate order, since their path parameter is a
 * `grantId`, not a `clientId`, and `clientId` must be resolved from the
 * grant row itself BEFORE `withStaffMutation` can set the tenant GUC - see
 * `impersonation-lifecycle-support.ts#loadGrantClientId`'s own header for
 * the exact mechanism, mirrored from `routes/topups.ts`'s approve/reject
 * pre-read).
 *
 * TARGET RESOLUTION: `target_user_id` defaults to the workspace OWNER
 * (`memberships` role `owner`) - a body `targetUserId` may name a DIFFERENT
 * member of the SAME client only; naming a user outside this client (or a
 * client with no owner membership at all) is a 404, indistinguishable from
 * "no such user", so a staff caller cannot probe cross-tenant membership.
 * `expires_at` is `now() + durationMinutes`; the DB CHECK
 * (`impersonation_grants_max_thirty_minutes`) is the ONE authority for the
 * 30-minute ceiling - a violation (23514) maps to 400 `VALIDATION_ERROR`,
 * never trusted to the contract's own `.max(30)` alone (defence in depth,
 * core invariant 3: invariants live at the storage layer).
 */

interface MembershipRow extends Record<string, unknown> {
  user_id: string;
}

async function resolveTargetUserId(
  tx: StaffMutationTx,
  clientId: string,
  requestedUserId: string | undefined,
): Promise<string> {
  if (requestedUserId) {
    const result = await tx.query<MembershipRow>(
      `SELECT user_id FROM memberships WHERE client_id = $1 AND user_id = $2
        -- client_id = $1`,
      [clientId, requestedUserId],
    );
    if (!result.rows[0]) {
      throw new InternalTargetNotFoundError('No such member for this client.');
    }
    return result.rows[0].user_id;
  }

  const owner = await tx.query<MembershipRow>(
    `SELECT user_id FROM memberships WHERE client_id = $1 AND role = 'owner'
      -- client_id = $1
      LIMIT 1`,
    [clientId],
  );
  if (!owner.rows[0]) {
    throw new InternalTargetNotFoundError('This client has no owner membership.');
  }
  return owner.rows[0].user_id;
}

const CODE_CHECK_VIOLATION = '23514';

function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === CODE_CHECK_VIOLATION
  );
}

function registerGrantRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: '/internal/v1/clients/:id/impersonation',
    scope: 'internal:impersonation:grant',
    action: 'impersonation.grant',
    bodySchema: grantImpersonationInputSchema,
    targetKind: 'impersonation_grant',
    resolveTarget: (pathId) => ({ clientId: pathId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const targetUserId = await resolveTargetUserId(tx, ctx.clientId, ctx.body.targetUserId);

      let grantId: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO impersonation_grants
             (client_id, staff_id, target_user_id, scope, reason, expires_at)
           VALUES ($1, $2, $3, 'metadata_only', $4, now() + make_interval(mins => $5))
           RETURNING id
           -- client_id = $1`,
          [ctx.clientId, tx.actor.staffId, targetUserId, ctx.body.reason, ctx.body.durationMinutes],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('impersonation grant INSERT returned no row');
        grantId = row.id;
      } catch (err) {
        if (isCheckViolation(err)) {
          throw new InternalValidationError(
            'A metadata-only impersonation grant may not exceed 30 minutes.',
          );
        }
        throw err;
      }

      const expiry = await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM impersonation_grants WHERE id = $1
          -- client_id = $1 (looked up by its own PK, already scoped to this
          -- client by the INSERT above)
         `,
        [grantId],
      );
      const expiresAt = expiry.rows[0]?.expires_at ?? new Date();

      await notify(tx, {
        clientId: ctx.clientId,
        kind: 'impersonation_started',
        transitionId: grantId,
        payload: {
          grantId,
          scope: 'metadata_only',
          expiresAt: expiresAt.toISOString(),
          staffLabel: tx.actor.label,
        },
      });

      return {
        grantId,
        clientId: ctx.clientId,
        scope: 'metadata_only' as const,
        expiresAt: expiresAt.toISOString(),
      };
    },
  });
}

export function registerInternalImpersonationRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerGrantRoute(app, deps, authDeps);
  registerImpersonationMintRoute(app, deps, authDeps);
  registerImpersonationElevateRoute(app, deps, authDeps);
  registerImpersonationRevokeRoute(app, deps, authDeps);
  registerImpersonationListRoute(app, deps, authDeps);
}
