import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { platformRead, type PlatformReadDeps } from '../../platform/platform-read.js';
import { reasonOf, staffCtxOf } from '../clients/clients.routes.js';
import { listWalletLedger } from './wallet.read.js';

/**
 * modules/wallet/wallet.routes.ts (P28 Unit U4, step 7) -
 * `GET /admin/v1/clients/:id/wallet/ledger`, keyset-paginated. The wallet
 * HEADER (state/balance/rate/threshold) is served as part of the
 * client-detail response rather than as its own endpoint, so a staff member
 * never sees a balance without the workspace context it belongs to.
 */

const paramsSchema = z.object({ id: z.uuid() }).strict();
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export interface WalletRoutesDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
}

export function registerWalletRoutes(app: FastifyInstance, deps: WalletRoutesDeps): void {
  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/clients/:id/wallet/ledger',
    policy: 'staff',
    action: 'wallet.read',
    handler: async (req, reply) => {
      const { id } = paramsSchema.parse(req.params);
      const query = querySchema.parse(req.query);
      const page = await platformRead(
        deps.read,
        staffCtxOf(req),
        {
          key: 'admin/backend/src/modules/wallet/wallet.read.ts:listWalletLedger',
          reason: reasonOf(req),
          clientId: id,
          targetType: 'wallet',
          targetId: id,
        },
        (db) => listWalletLedger(db, { clientId: id, ...query }),
      );
      sendSuccess(reply, requestIdFor(req), page);
    },
  });
}
