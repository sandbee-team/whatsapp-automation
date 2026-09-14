import type { FastifyInstance } from 'fastify';
import type { TenantDb } from '@wp/db';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import { registerTopupsRoutes, type TopupsRoutesDeps } from './topups.routes.js';

/**
 * wallet.routes.ts (P19 Unit U4, step 7/9/11) - `GET /v1/wallet` (balance/
 * state/threshold/estimated remaining messages) plus wiring for the
 * top-up routes (`topups.routes.ts`, registered from here so
 * `roles/api.ts`/`platform/http/server.ts` gain a single `wallet` dep,
 * matching `notifications.routes.ts`'s one-module-one-dep shape).
 * `policy: 'session'`, scope `wallet:read` - tenant scope comes from
 * `req.auth!.clientId` ONLY (binding correction #9).
 *
 * ESTIMATED REMAINING MESSAGES (binding correction #11) - a unit-boundary
 * conversion (paise -> a message COUNT), so it is computed in exactly ONE
 * place: SQL integer division `balance_minor / max_rate_minor`, `GREATEST(
 * ..., 0)` to clamp a negative balance (an absorbed overdraft, see
 * `wallet-credit.sql`'s own header) to zero rather than a negative "messages
 * remaining" - never a JS float division, never `parseFloat`. Money itself
 * stays a `bigint` read back `::text` and parsed with `Number()` only for
 * the wire-safe `balanceMinor` field (paise values here are always far
 * below `Number.MAX_SAFE_INTEGER` for any real wallet).
 */

export interface WalletRoutesDeps {
  tenantDb: TenantDb;
  topups?: Omit<TopupsRoutesDeps, 'tenantDb'>;
}

interface WalletSummaryRow extends Record<string, unknown> {
  balance_minor: string;
  state: 'active' | 'low' | 'empty' | 'frozen';
  low_balance_threshold_minor: string;
  max_rate_minor: string;
  estimated_messages_remaining: string;
}

export function registerWalletRoutes(
  app: FastifyInstance,
  deps: WalletRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'GET',
    path: '/v1/wallet',
    policy: 'session',
    scope: 'wallet:read',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const auth = req.auth!;
        const row = await deps.tenantDb.withTenant(auth.clientId, (tx) =>
          tx.query<WalletSummaryRow>(
            `SELECT balance_minor::text AS balance_minor,
                    state,
                    low_balance_threshold_minor::text AS low_balance_threshold_minor,
                    max_rate_minor::text AS max_rate_minor,
                    GREATEST(balance_minor / max_rate_minor, 0)::text AS estimated_messages_remaining
               FROM wallet_accounts
              WHERE client_id = $1`,
            [auth.clientId],
          ),
        );

        const wallet = row.rows[0];
        if (!wallet) {
          sendError(reply, requestId, new WalletNotFoundError());
          return;
        }

        sendSuccess(reply, requestId, {
          balanceMinor: Number(wallet.balance_minor),
          state: wallet.state,
          lowBalanceThresholdMinor: Number(wallet.low_balance_threshold_minor),
          maxRateMinor: Number(wallet.max_rate_minor),
          estimatedMessagesRemaining: Number(wallet.estimated_messages_remaining),
        });
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });

  if (deps.topups) {
    registerTopupsRoutes(app, { tenantDb: deps.tenantDb, ...deps.topups }, authDeps);
  } else {
    registerTopupsRoutes(app, { tenantDb: deps.tenantDb }, authDeps);
  }
}

class WalletNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('Wallet not found.');
    this.name = 'WalletNotFoundError';
  }
}
