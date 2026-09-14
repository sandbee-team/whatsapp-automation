import type { FastifyInstance } from 'fastify';
import { revokeImpersonationInputSchema } from '@wp/contracts';
import { bumpTokenEpoch, writeEpochCache } from '../../identity/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import {
  assertInternalAccess,
  mapInternalError,
  parseMutationHeaders,
  sendUnauthorized,
} from '../internal-access.js';
import { computeRequestHash, withAdminAppRole } from '../staff-audit.js';
import { withStaffMutation } from '../with-staff-mutation.js';
import { resolveStaffActor, assertStaffCan } from '../actor.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { InternalTargetNotFoundError } from './internal-errors.js';
import {
  grantIdFrom,
  loadGrantClientId,
  lockGrantOrThrow,
} from './impersonation-lifecycle-support.js';

/**
 * routes/impersonation-revoke-list.ts (P28 Unit U3c) - REVOKE
 * (`POST /internal/v1/impersonation/:grantId/revoke`) and LIST
 * (`GET /internal/v1/clients/:id/impersonation`), the two remaining
 * lifecycle routes (300-line cap split of `impersonation-lifecycle.ts`).
 *
 * REVOKE: honestly documented - natural EXPIRY does NOT bump `token_epoch`
 * (an expired grant's last-minted token simply dies at its own 2-minute
 * TTL); only an EXPLICIT revoke bumps it, same writer/same-transaction
 * discipline as `session-logout.ts#logout`, so every impersonation token
 * (mint AND any refresh) for the target user becomes unverifiable from the
 * next `validateAccessToken` call onward and the SSE authz tick drops the
 * connection within its own tick interval. This also logs the REAL owner
 * out - intended, a visible security event, not a side effect to suppress.
 */
export function registerImpersonationRevokeRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  const path = '/internal/v1/impersonation/:grantId/revoke';
  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: 'internal:impersonation:revoke',
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
        const body = revokeImpersonationInputSchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, { grantId, body });

        const clientId = await loadGrantClientId(deps, grantId);
        if (!clientId) throw new InternalTargetNotFoundError('No such impersonation grant.');

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: 'impersonation.revoke',
            clientId,
            targetKind: 'impersonation_grant',
            targetRef: grantId,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            const grant = await lockGrantOrThrow(tx, clientId, grantId);
            const revokedAt = new Date();

            // Conditional UPDATE, both the named grant AND any elevation
            // chained off it - revoking a metadata grant must also kill the
            // message-body elevation it spawned. `revoked_at IS NULL` keeps
            // this idempotent: a repeat revoke of an already-revoked grant
            // changes nothing.
            await tx.query(
              // `SET` stays on the `UPDATE` line: the `wp/no-plain-set` guard
              // matches a line-leading `SET `, which a wrapped clause would trip
              // (same idiom as `routes/clients.ts#transitionClientStatus`).
              `UPDATE impersonation_grants SET revoked_at = $3, revoked_reason = $4
                WHERE (id = $1 OR parent_grant_id = $1) AND client_id = $2 AND revoked_at IS NULL
                -- client_id = $2`,
              [grantId, clientId, revokedAt, body.reason],
            );

            if (grant.target_user_id) {
              const targetUserId = grant.target_user_id;
              const newEpoch = await bumpTokenEpoch(tx, targetUserId);
              tx.afterCommit(() =>
                writeEpochCache(
                  {
                    redis: authDeps.tokenEpochCtx.redis,
                    env: authDeps.tokenEpochCtx.env,
                    epochCacheTtlSec: authDeps.tokenEpochCtx.epochCacheTtlSec,
                  },
                  targetUserId,
                  newEpoch,
                ),
              );
            }

            return { grantId, revokedAt: revokedAt.toISOString() };
          },
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}

interface ListGrantRow extends Record<string, unknown> {
  id: string;
  staff_id: string;
  scope: 'metadata_only' | 'with_message_bodies';
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** `GET /internal/v1/clients/:id/impersonation` - active + last 20 grants, ids/enums/timestamps only (no reason/target_user_id in the response - a read route need not echo the audit trail's free-text field). */
export function registerImpersonationListRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/internal/v1/clients/:id/impersonation',
    policy: 'public',
    scope: 'internal:impersonation:list',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        const clientId = (req.params as { id: string }).id;
        const actorHeader = req.headers['x-actor'];

        const items = await withAdminAppRole(deps.pool, async (db) => {
          const actor = await resolveStaffActor(
            db,
            typeof actorHeader === 'string' ? actorHeader : '',
          );
          assertStaffCan(actor, 'clients.read');
          const result = await db.query<ListGrantRow>(
            `SELECT id, staff_id, scope, created_at, expires_at, revoked_at
               FROM impersonation_grants
              WHERE client_id = $1
              ORDER BY created_at DESC
              LIMIT 20`,
            [clientId],
          );
          return result.rows;
        });

        sendSuccess(reply, requestId, {
          items: items.map((row) => ({
            grantId: row.id,
            staffId: row.staff_id,
            scope: row.scope,
            createdAt: row.created_at.toISOString(),
            expiresAt: row.expires_at.toISOString(),
            revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
          })),
        });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
