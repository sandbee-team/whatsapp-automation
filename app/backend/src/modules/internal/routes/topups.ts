import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approveTopupInputSchema,
  rejectTopupInputSchema,
  listTopupsQuerySchema,
} from '@wp/contracts';
import { creditWalletInTx, publishWakeForClient } from '../../wallet/index.js';
import { notify } from '../../notifications/index.js';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import {
  assertInternalAccess,
  mapInternalError,
  markTopupDecided,
  parseMutationHeaders,
  readTopupAmountMinor,
  readTopupForDecision,
  readTopupsByStatus,
  sendUnauthorized,
  TopupNotFoundError,
  TopupNotPendingError,
} from '../internal-access.js';
import { computeRequestHash, withAdminAppRole } from '../staff-audit.js';
import { withStaffMutation } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';

/**
 * routes/topups.ts (P28 Unit U3a, step 4) - `POST /internal/v1/topups/:id/
 * {approve,reject}` (mutations, `withStaffMutation`) and `GET
 * /internal/v1/topups` (read-only, `withAdminAppRole`, unchanged shape from
 * the P19 stopgap). `approve` keeps the P19 IDEMPOTENT status-flip
 * (pending -> approved falls through; approved falls through with no status
 * write; rejected -> 409) inside `tx.asAdminRole(...)` - the
 * `topup_requests` status UPDATE's column grant belongs to `wp_admin_app`
 * (migration 0058), never `wp_app`.
 */

function registerApproveRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  path: string,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: 'internal:topups.approve',
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
        const id = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const body = approveTopupInputSchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, body);

        // The topup's own client is not known until inside the mutation
        // (the id is all the route has) - read it under wp_admin_app first,
        // outside withStaffMutation, purely to get the clientId for the
        // tenant GUC; the actual status decision happens inside the
        // mutation's own transaction via tx.asAdminRole.
        const clientIdForLookup = await withAdminAppRole(deps.pool, async (db) => {
          const row = await readTopupForDecision(db, id);
          if (!row) throw new TopupNotFoundError();
          return row.clientId;
        });

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: 'topups.approve',
            clientId: clientIdForLookup,
            targetKind: 'topup_request',
            targetRef: id,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            const decided = await tx.asAdminRole(async (db) => {
              const row = await readTopupForDecision(db, id, true);
              if (!row) throw new TopupNotFoundError();
              if (row.status === 'rejected') throw new TopupNotPendingError();
              if (row.status === 'pending') {
                await markTopupDecided(db, {
                  id,
                  status: 'approved',
                  staffId: tx.actor.staffId,
                  reason: body.reason,
                });
              }
              return row;
            });

            const creditResult = await creditWalletInTx(
              tx,
              { nowMs: (deps.now ? deps.now() : new Date()).getTime() },
              {
                clientId: decided.clientId,
                amountMinor: decided.amountMinor,
                kind: 'topup_manual',
                reason: body.reason,
                externalRef: `topup:${id}`,
                staffId: tx.actor.staffId,
              },
            );

            if (!creditResult.replayed) {
              await notify(tx, {
                clientId: decided.clientId,
                kind: 'wallet_credited_by_staff',
                transitionId: String(tx.auditId),
                payload: { amountMinor: decided.amountMinor.toString(), kind: 'topup_manual' },
              });
              const wasZeroClaim =
                creditResult.stateBefore === 'empty' || creditResult.stateBefore === 'frozen';
              const isNowClaimable =
                creditResult.stateAfter === 'active' || creditResult.stateAfter === 'low';
              if (wasZeroClaim && isNowClaimable) {
                tx.afterCommit(async () => {
                  await deps.tenantDb.withTenant(decided.clientId, (readTx) =>
                    publishWakeForClient(
                      { db: readTx, publishWake: deps.publishWake },
                      decided.clientId,
                    ),
                  );
                });
              }
            }

            return { topupRequestId: id, status: 'approved' as const };
          },
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}

function registerRejectRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  path: string,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path,
    policy: 'public',
    scope: 'internal:topups.reject',
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
        const id = z
          .string()
          .uuid()
          .parse((req.params as { id: string }).id);
        const body = rejectTopupInputSchema.parse(req.body);
        const requestHash = computeRequestHash('POST', path, body);

        const clientId = await withAdminAppRole(deps.pool, async (db) => {
          const row = await readTopupForDecision(db, id);
          if (!row) throw new TopupNotFoundError();
          return row.clientId;
        });

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: 'topups.reject',
            clientId,
            targetKind: 'topup_request',
            targetRef: id,
            reason: body.reason,
            requestHash,
          },
          async (tx) => {
            await tx.asAdminRole(async (db) => {
              const decided = await markTopupDecided(db, {
                id,
                status: 'rejected',
                staffId: tx.actor.staffId,
                reason: body.reason,
              });
              if (decided === 0) {
                throw new TopupNotPendingError();
              }
            });

            const amountMinor = await readTopupAmountMinor(tx, id);
            await notify(tx, {
              clientId,
              kind: 'topup_rejected',
              transitionId: String(tx.auditId),
              payload: {
                topupRequestId: id,
                amountMinor: (amountMinor ?? 0n).toString(),
              },
            });

            return { topupRequestId: id, status: 'rejected' as const };
          },
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}

export function registerInternalTopupsRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerApproveRoute(app, deps, authDeps, '/internal/v1/topups/:id/approve');
  registerRejectRoute(app, deps, authDeps, '/internal/v1/topups/:id/reject');

  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/internal/v1/topups',
    policy: 'public',
    scope: 'internal:topups.read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        const query = listTopupsQuerySchema.parse(req.query);
        const items = await withAdminAppRole(deps.pool, (db) =>
          readTopupsByStatus(db, query.status),
        );
        sendSuccess(reply, requestId, {
          // `createdAt` projects the seeded row's OWN `created_at`
          // (`readTopupsByStatus`) - never a fabricated `new Date()` at
          // response time (C1 review round 2 MINOR fix).
          items: items.slice(0, query.limit).map((item) => ({
            id: item.id,
            clientId: item.clientId,
            amountMinor: item.amountMinor.toString(),
            status: item.status,
            createdAt: item.createdAt,
          })),
        });
      } catch (err) {
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
