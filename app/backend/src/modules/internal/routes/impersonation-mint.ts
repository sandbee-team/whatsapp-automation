import type { FastifyInstance } from 'fastify';
import { mintImpersonationTokenInputSchema } from '@wp/contracts';
import { signImpersonationToken, getUserTokenEpoch } from '../../identity/index.js';
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
  loadGrantClientId,
  lockGrantOrThrow,
} from './impersonation-lifecycle-support.js';

/**
 * routes/impersonation-mint.ts (P28 Unit U3c; C1 review round 2, MAJOR 2
 * linked MINOR fix - token never stored in the audit log) -
 * `POST /internal/v1/impersonation/:grantId/token`. Audited as
 * `impersonation.grant` (minting IS granting access, from the RBAC matrix's
 * point of view - not a new action) via `withStaffMutation`.
 *
 * `withStaffMutation` stores whatever `fn` returns, verbatim, in
 * `staff_audit_log.result` AND replays that same value as the HTTP response
 * body on a replayed call - so `fn` must never return the raw bearer token,
 * or every access token this route ever minted would sit in the audit log
 * forever. `fn` therefore returns the REDACTED shape
 * `{grantId, scope, expiresAt, tokenIssued: true}` (what gets stored and
 * what a replay returns); the real `accessToken`/`panelEntryPath` are
 * captured via `mintedForResponse` and merged into the response ONLY on the
 * winning (non-replayed) call, so a replayed Idempotency-Key returns
 * `{..., replayed: true, accessToken: null, panelEntryPath: null}` - it
 * never re-emits the token.
 */
export function registerImpersonationMintRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  const path = '/internal/v1/impersonation/:grantId/token';
  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: 'internal:impersonation:token',
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
        const body = mintImpersonationTokenInputSchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, { grantId, body });

        const clientId = await loadGrantClientId(deps, grantId);
        if (!clientId) throw new InternalTargetNotFoundError('No such impersonation grant.');

        let mintedForResponse: { accessToken: string; panelEntryPath: string } | undefined;

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: 'impersonation.grant',
            clientId,
            targetKind: 'impersonation_grant',
            targetRef: grantId,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            const grant = await lockGrantOrThrow(tx, clientId, grantId);
            if (grant.revoked_at || grant.expires_at.getTime() <= Date.now()) {
              throw new InternalInvalidStateError('This impersonation grant is no longer active.');
            }
            if (!grant.target_user_id) {
              throw new InternalInvalidStateError('This impersonation grant has no target user.');
            }

            const membership = await tx.query<{ role: string }>(
              `SELECT role FROM memberships WHERE client_id = $1 AND user_id = $2
                -- client_id = $1`,
              [clientId, grant.target_user_id],
            );
            const role = membership.rows[0]?.role;
            if (!role) {
              throw new InternalInvalidStateError('The target user is no longer a member.');
            }

            const epoch = await getUserTokenEpoch(tx, grant.target_user_id);
            const minted = await signImpersonationToken({
              jwtSecret: authDeps.tokenEpochCtx.jwtSecret,
              targetUserId: grant.target_user_id,
              grantId: grant.id,
              clientId,
              role,
              epoch,
              scope: grant.scope,
              staffId: tx.actor.staffId,
            });

            mintedForResponse = {
              accessToken: minted.accessToken,
              panelEntryPath: `/impersonate#token=${minted.accessToken}&exp=${minted.expiresAt.toISOString()}`,
            };

            return {
              expiresAt: minted.expiresAt.toISOString(),
              scope: grant.scope,
              grantId: grant.id,
              tokenIssued: true,
            };
          },
        );

        sendSuccess(reply, requestId, {
          ...result.data,
          replayed: result.replayed,
          accessToken: result.replayed ? null : (mintedForResponse?.accessToken ?? null),
          panelEntryPath: result.replayed ? null : (mintedForResponse?.panelEntryPath ?? null),
        });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
