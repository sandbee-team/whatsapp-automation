import type { FastifyInstance } from 'fastify';
import { elevateImpersonationInputSchema } from '@wp/contracts';
import { notify } from '../../notifications/index.js';
import { provisioningRepo } from '../../tenancy/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import {
  assertInternalAccess,
  mapInternalError,
  parseMutationHeaders,
  sendUnauthorized,
} from '../internal-access.js';
import { computeRequestHash } from '../staff-audit.js';
import { withStaffMutation } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { InternalTargetNotFoundError, InternalInvalidStateError } from './internal-errors.js';
import {
  grantIdFrom,
  isCheckViolation,
  loadGrantClientId,
  lockGrantOrThrow,
} from './impersonation-lifecycle-support.js';

/**
 * routes/impersonation-elevate.ts (P28 Unit U3c) -
 * `POST /internal/v1/impersonation/:grantId/elevate`. Action
 * `impersonation.elevate` is SUPERADMIN-only per `@wp/domain`'s `canStaff`
 * matrix (re-checked server-side inside `withStaffMutation` - `support`/
 * `ops` are both 403, no route-level role check needed here). Inserts a NEW
 * grant row `scope='with_message_bodies'`, `parent_grant_id` set - the
 * ELEVATED grant is a distinct, separately-audited, separately-revocable
 * row, never an in-place scope flip on the metadata grant.
 */
export function registerImpersonationElevateRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  const path = '/internal/v1/impersonation/:grantId/elevate';
  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: 'internal:impersonation:elevate',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        parseMutationHeaders(req);
        const grantId = grantIdFrom(req);
        const body = elevateImpersonationInputSchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, { grantId, body });

        const clientId = await loadGrantClientId(deps, grantId);
        if (!clientId) throw new InternalTargetNotFoundError('No such impersonation grant.');

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: 'impersonation.elevate',
            clientId,
            targetKind: 'impersonation_grant',
            targetRef: grantId,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            const parent = await lockGrantOrThrow(tx, clientId, grantId);
            if (parent.revoked_at || parent.expires_at.getTime() <= Date.now()) {
              throw new InternalInvalidStateError('This impersonation grant is no longer active.');
            }

            try {
              const inserted = await tx.query<{ id: string; expires_at: Date }>(
                `INSERT INTO impersonation_grants
                   (client_id, staff_id, target_user_id, scope, reason, parent_grant_id, expires_at)
                 VALUES ($1, $2, $3, 'with_message_bodies', $4, $5,
                         LEAST(now() + make_interval(mins => $6), $7))
                 RETURNING id, expires_at
                 -- client_id = $1`,
                [
                  clientId,
                  tx.actor.staffId,
                  parent.target_user_id,
                  body.reason,
                  grantId,
                  body.durationMinutes,
                  parent.expires_at,
                ],
              );
              const row = inserted.rows[0];
              if (!row) throw new Error('elevated grant INSERT returned no row');

              // Tenant-visible `audit_logs` row, DISTINCT from the
              // `staff_audit_log` row `withStaffMutation` already wrote
              // (whose `action` is the RBAC action string,
              // `impersonation.elevate`) - `impersonation_body_elevation` is
              // the exact string this event is audited under for the
              // tenant's own audit trail (module dispatch binding).
              await provisioningRepo.insertAuditLog(tx, {
                clientId,
                actorType: 'staff',
                actorStaffId: tx.actor.staffId,
                impersonatedByStaffId: tx.actor.staffId,
                action: 'impersonation_body_elevation',
                targetType: 'impersonation_grant',
                targetId: row.id,
              });

              await notify(tx, {
                clientId,
                kind: 'impersonation_body_access',
                transitionId: row.id,
                payload: {
                  grantId: row.id,
                  parentGrantId: grantId,
                  expiresAt: row.expires_at.toISOString(),
                },
              });

              return {
                grantId: row.id,
                parentGrantId: grantId,
                scope: 'with_message_bodies' as const,
                expiresAt: row.expires_at.toISOString(),
              };
            } catch (err) {
              if (isCheckViolation(err)) {
                throw new InternalInvalidStateError(
                  'A message-body-access elevation may not exceed 15 minutes.',
                );
              }
              throw err;
            }
          },
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
