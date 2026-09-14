import type { FastifyInstance } from 'fastify';
import {
  SignupConflictError,
  DefaultPriceListMissingError,
  NoDefaultPlanError,
} from './signup.service.js';
import { AuthenticationError, AccountLockedError } from './login.service.js';
import { registerAuthRoutes } from './auth.routes.js';
import { registerTotpRoutes } from './totp.routes.js';
import { registerTotpRecoveryRoutes } from './totp-recovery.routes.js';
import { registerImpersonationRefreshRoute } from './impersonation-session-routes.js';
import { registerPasswordRoutes } from './password.routes.js';
import { type IdentityRoutesDeps, type IdentityMailerDeps, authDepsFrom } from './routes-shared.js';

/**
 * modules/identity/identity.routes.ts (P04a Unit UA6; split P04a FIXD) -
 * the single registration entry point `modules/identity/index.ts` exposes
 * (layering rule: other modules import only `index.ts`, never a sibling
 * file directly). Binds the auth contract's routes (`@wp/contracts`'s
 * `authContract`) to the identity services, ALL through
 * `route-policy.ts#registerRoute` (fail-closed routing, canon) - the actual
 * route registrations now live in `auth.routes.ts` (signup/verify/login/
 * refresh/logout/me) and `totp.routes.ts` (totp verify/enrol/confirm),
 * split out for max-lines; shared deps/types/helpers live in
 * `routes-shared.ts`. Pure code motion: no behavior change from the
 * original single-file identity.routes.ts (P04a FIXD).
 *
 * Transport decision (deviation, filed here per the phase task): plain,
 * contract-validated Fastify routes rather than `@orpc/server`'s node
 * adapter - the 15-minute timebox for evaluating the oRPC adapter would
 * have consumed most of this unit's remaining budget against the
 * route-policy/rate-limit/cookie requirements, so this goes straight to the
 * documented fallback: each handler parses `req.body` with the contract's
 * INPUT zod schema (validate-and-replace - the handler only ever sees the
 * parsed output) and returns data shaped to the OUTPUT schema.
 */

export type { IdentityRoutesDeps, IdentityMailerDeps };
export { totpLockoutDurationMs } from './routes-shared.js';

/** Registers every P04a auth route - ALL through `registerRoute` (fail-closed routing, canon). */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  const authDeps = authDepsFrom(deps);
  registerAuthRoutes(app, deps, authDeps);
  registerTotpRoutes(app, deps, authDeps);
  registerTotpRecoveryRoutes(app, deps, authDeps);
  registerPasswordRoutes(app, deps, authDeps);
  registerImpersonationRefreshRoute(
    app,
    { tenantDb: deps.tenantDb, tokenEpochCtx: authDeps.tokenEpochCtx, redis: deps.redis },
    authDeps,
  );
}

export {
  AuthenticationError,
  AccountLockedError,
  SignupConflictError,
  DefaultPriceListMissingError,
  NoDefaultPlanError,
};
