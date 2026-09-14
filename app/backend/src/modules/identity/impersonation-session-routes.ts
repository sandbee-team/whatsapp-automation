import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { TenantDb } from '@wp/db';
import type { TenantQueryable } from '@wp/db';
import { UnauthenticatedError, validateAccessToken, type TokenEpochCtx } from './token-epoch.js';
import { signImpersonationToken } from './impersonation-token.js';
import { findImpersonationGrant, staffLabelFor } from './impersonation-session-repo.js';
import { provisioningRepo } from '../tenancy/index.js';
import type { AuthDeps } from '../../platform/http/auth-plugin.js';
import type { AuthenticatedContext } from '../../platform/http/route-policy.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import { registerRoute } from '../../platform/http/route-policy.js';
import { createRateLimiter, type RateLimiter } from '../../platform/http/rate-limit.js';
import { sysKey } from '../../platform/redis.js';

/**
 * impersonation-session-routes.ts (P28 Unit U3c) - `POST /v1/auth/
 * impersonation/refresh`, the ONE way an impersonation token is renewed
 * (`policy: 'public'` - the route reads its OWN bearer token via
 * `validateAccessToken`, never `req.auth`, since a token 90s from expiry must
 * still be refreshable and `enforcePolicy`'s own `session` policy would
 * accept it identically; `public` here means "no MFA-policy branching", not
 * "no token required" - see the 401 path below). Re-reads the grant on every
 * call: a revoked or expired grant mints nothing, ever, no matter how fresh
 * the presented token's own signature still is.
 */

export interface ImpersonationSessionRoutesDeps {
  tenantDb: TenantDb;
  tokenEpochCtx: TokenEpochCtx;
  /** Rate-limit port, omitted only by fixtures that never exercise this route - see the fail-closed check below. */
  redis?: Redis;
  now?: () => Date;
}

function rateLimiterFor(redis: Redis): RateLimiter {
  return createRateLimiter(redis);
}

export function registerImpersonationRefreshRoute(
  app: FastifyInstance,
  deps: ImpersonationSessionRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerRoute(app, authDeps, {
    method: 'POST',
    path: '/v1/auth/impersonation/refresh',
    policy: 'public',
    scope: 'auth:impersonation:refresh',
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      try {
        const header = req.headers.authorization;
        const token =
          header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
        if (!token) throw new UnauthenticatedError();

        const claims = await validateAccessToken(deps.tokenEpochCtx, token);
        if (!claims.imp) throw new UnauthenticatedError();

        if (deps.redis) {
          const limiter = rateLimiterFor(deps.redis);
          const rl = await limiter.consume([
            {
              key: sysKey(deps.tokenEpochCtx.env, 'rl', 'imp', 'refresh', claims.imp.grantId),
              capacity: 30,
              refillPerSec: 30 / 600,
              failClosed: true,
            },
          ]);
          if (!rl.allowed) throw new UnauthenticatedError();
        }

        const now = deps.now ? deps.now() : new Date();

        const result = await deps.tenantDb.withTenant(claims.clientId, async (tx) => {
          const grant = await findImpersonationGrant(tx, claims.clientId, claims.imp!.grantId);
          if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= now.getTime()) {
            throw new UnauthenticatedError();
          }

          const minted = await signImpersonationToken(
            {
              jwtSecret: deps.tokenEpochCtx.jwtSecret,
              targetUserId: claims.sub,
              grantId: grant.id,
              clientId: claims.clientId,
              role: claims.role,
              epoch: claims.epoch,
              scope: grant.scope,
              staffId: grant.staffId,
            },
            now,
          );

          await provisioningRepo.insertAuditLog(tx, {
            clientId: claims.clientId,
            actorType: 'staff',
            actorStaffId: grant.staffId,
            impersonatedByStaffId: grant.staffId,
            action: 'impersonation.token_refreshed',
            targetType: 'impersonation_grant',
            targetId: grant.id,
          });

          return minted;
        });

        sendSuccess(reply, requestId, {
          accessToken: result.accessToken,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (err) {
        sendError(reply, requestId, err);
      }
    },
  });
}

export interface MeImpersonationField {
  grantId: string;
  scope: string;
  expiresAt: string;
  staffLabel: string;
}

/**
 * The `impersonation` field `GET /v1/auth/me` adds to its response when
 * `auth.imp` is set - re-reads the grant (never trusts the token's own
 * `scope`/`expiresAt` claims, both of which could be stale relative to a
 * just-elevated or just-revoked grant) plus the staff member's `full_name`.
 * Returns `undefined` for an ordinary session OR a grant that has since
 * vanished (defensive only - the epoch bump on revoke already kills the
 * token before this could normally be reached).
 */
export async function meImpersonationFieldFor(
  tx: TenantQueryable,
  auth: AuthenticatedContext,
): Promise<MeImpersonationField | undefined> {
  if (!auth.imp) return undefined;
  const grant = await findImpersonationGrant(tx, auth.clientId, auth.imp.grantId);
  if (!grant) return undefined;
  const staffLabel = await staffLabelFor(tx, grant.staffId);
  return {
    grantId: grant.id,
    scope: grant.scope,
    expiresAt: grant.expiresAt.toISOString(),
    staffLabel: staffLabel ?? 'WP staff',
  };
}
