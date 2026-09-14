import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import {
  platformRead,
  type PlatformReadDeps,
  type StaffCtx,
} from '../../platform/platform-read.js';
import { listClients, readClient } from './clients.read.js';
import { listClientInstances } from '../instances/instances.read.js';
import { readClientLimits } from '../plans/plans.read.js';
import { readClientPricing, readWalletAccount } from '../wallet/wallet.read.js';
import { listActiveImpersonations, listRecentClientStaffActions } from '../audit/audit.read.js';

/**
 * modules/clients/clients.routes.ts (P28 Unit U4, step 7) - the client list
 * and detail endpoints. Every handler is
 * `authenticateStaff` (by `registerAdminRoute`'s `'staff'` policy) ->
 * `assertStaffCan(action)` (same) -> `platformRead(...)`, so no read path
 * exists that skips authentication, authorization, or the audit row.
 *
 * THE STAFF `reason`: a platform read carries the staff member's stated
 * reason into its audit row. On a READ endpoint it arrives as the
 * `X-Staff-Reason` header rather than a body (a GET has no body), and when
 * absent it is recorded as `'unspecified'` rather than rejected: blocking a
 * staff member from opening a list until they type a justification would
 * push them toward `psql`, which is NOT audited at all (see
 * docs/RUNBOOK.md's honest note). Recording "they looked, and gave no
 * reason" is strictly more truthful than recording nothing.
 */

const DEFAULT_DETAIL_LIMIT = 50;

const listQuerySchema = z
  .object({
    status: z.string().trim().min(1).max(40).optional(),
    q: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const clientIdParamsSchema = z.object({ id: z.uuid() }).strict();

/** The acting staff member plus request-scoped audit facts, built from the authenticated request. */
export function staffCtxOf(req: FastifyRequest): StaffCtx {
  return { staffId: req.staff!.staffId, requestId: requestIdFor(req), ip: req.ip };
}

/** The staff member's stated reason for this read (see the module header for why absence is recorded, not refused). */
export function reasonOf(req: FastifyRequest): string {
  const header = req.headers['x-staff-reason'];
  return typeof header === 'string' && header.trim().length > 0
    ? header.trim().slice(0, 500)
    : 'unspecified';
}

export interface ClientsRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerClientsRoutes(app: FastifyInstance, deps: ClientsRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/clients',
    policy: 'staff',
    action: 'clients.read',
    handler: async (req, reply) => {
      const query = listQuerySchema.parse(req.query);
      const page = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/clients/clients.read.ts:listClients',
          reason: reasonOf(req),
        },
        (db) => listClients(db, query),
      );
      sendSuccess(reply, requestIdFor(req), page);
    },
  });

  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/clients/:id',
    policy: 'staff',
    action: 'clients.read',
    handler: async (req, reply) => {
      const { id } = clientIdParamsSchema.parse(req.params);
      const ctx = staffCtxOf(req);
      const reason = reasonOf(req);
      const target = { clientId: id, targetType: 'client', targetId: id };

      const client = await platformRead(
        deps.read,
        ctx,
        { key: 'admin/backend/src/modules/clients/clients.read.ts:readClient', reason, ...target },
        (db) => readClient(db, id),
      );
      if (!client) {
        sendSuccess(reply, ctx.requestId, null, 404);
        return;
      }

      // Each sub-read is its own registered platform read, so the audit
      // trail records exactly which facets of a workspace were opened - not
      // just "someone viewed a client".
      const limits = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/plans/plans.read.ts:readClientLimits',
          reason,
          ...target,
        },
        (db) => readClientLimits(db, id),
      );
      const pricing = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/wallet/wallet.read.ts:readClientPricing',
          reason,
          ...target,
        },
        (db) => readClientPricing(db, id),
      );
      const wallet = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/wallet/wallet.read.ts:readWalletAccount',
          reason,
          ...target,
        },
        (db) => readWalletAccount(db, id),
      );
      const instances = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/instances/instances.read.ts:listClientInstances',
          reason,
          ...target,
        },
        (db) => listClientInstances(db, id, DEFAULT_DETAIL_LIMIT),
      );
      const recentStaffActions = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/audit/audit.read.ts:listRecentClientStaffActions',
          reason,
          ...target,
        },
        (db) => listRecentClientStaffActions(db, id, DEFAULT_DETAIL_LIMIT),
      );
      const activeImpersonations = await platformRead(
        deps.read,
        ctx,
        {
          key: 'admin/backend/src/modules/audit/audit.read.ts:listActiveImpersonations',
          reason,
          ...target,
        },
        (db) => listActiveImpersonations(db, id, DEFAULT_DETAIL_LIMIT),
      );

      sendSuccess(reply, ctx.requestId, {
        ...client,
        limits,
        pricing: pricing ?? null,
        wallet: wallet ?? null,
        instances,
        recentStaffActions,
        activeImpersonations,
      });
    },
  });
}
