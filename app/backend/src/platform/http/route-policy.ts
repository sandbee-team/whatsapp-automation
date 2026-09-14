import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { AccessTokenClaims } from '../../modules/identity/token-epoch.js';
import { UnauthenticatedError } from '../../modules/identity/token-epoch.js';
import { verifyApiKey } from '../../modules/api-keys/verify.js';
import { authenticateRequest, type AuthDeps } from './auth-plugin.js';
import { requestIdFor, sendError } from './error-mapper.js';
import { assertImpersonationWriteAllowed } from './impersonation-write-guard.js';

/**
 * platform/http/route-policy.ts (P04a Unit UA6) - FAIL-CLOSED ROUTING (canon):
 * every route MUST be registered through `registerRoute` declaring an
 * explicit `policy` and `scope`; a route registered without either THROWS AT
 * BOOT naming the offending route. No route reaches Fastify any other way -
 * there is no second registration path in this codebase that could bypass
 * this check.
 *
 * MFA policy semantics (canon, binding):
 *  - 'public': no authentication.
 *  - 'session': a valid access token is required.
 *  - 'session_mfa': a valid access token AND (the token's `mfa` claim is
 *    `true`, OR the caller's role is not 'owner' AND has no TOTP enrolled).
 *    An owner with no TOTP enrolled -> 403 MFA_ENROLL_REQUIRED (TOTP is
 *    mandatory for owner). Anyone else with TOTP enrolled but a non-MFA
 *    session -> 401 MFA_REQUIRED.
 *  - 'session_or_api_key' (go-live U3, founder decision 2026-09-14): a
 *    bearer starting with `wp_live_` authenticates as an API key
 *    (`modules/api-keys/verify.ts`), populating `req.apiKeyAuth` - a
 *    SEPARATE property from `req.auth` (never a union - see that field's own
 *    doc comment). Any other bearer runs the EXACT SAME `session_mfa` branch
 *    below - an api-key-eligible route is never a downgrade of the MFA
 *    requirement for a logged-in human session.
 */

export type AuthPolicy = 'public' | 'session' | 'session_mfa' | 'session_or_api_key';

const VALID_POLICIES: ReadonlySet<string> = new Set<AuthPolicy>([
  'public',
  'session',
  'session_mfa',
  'session_or_api_key',
]);

export class MfaRequiredError extends Error {
  readonly code = 'MFA_REQUIRED';
  constructor() {
    super('This action requires a fresh MFA-verified session.');
    this.name = 'MfaRequiredError';
  }
}

export class MfaEnrollRequiredError extends Error {
  readonly code = 'MFA_ENROLL_REQUIRED';
  constructor() {
    super('TOTP MFA enrolment is required for this account.');
    this.name = 'MfaEnrollRequiredError';
  }
}

export interface AuthenticatedContext {
  userId: string;
  sessionId: string;
  clientId: string;
  role: string;
  epoch: number;
  /** Present only for a staff-minted impersonation token (P28 Unit U3c) - see `modules/identity/impersonation-principal.ts`. */
  imp?: AccessTokenClaims['imp'];
}

/**
 * Go-live U3: the api-key principal for a `session_or_api_key` route,
 * resolved by `modules/api-keys/verify.ts#verifyApiKey`. Deliberately a
 * SEPARATE request property from `req.auth`, never a union merged into it -
 * ~100 existing handlers read `req.auth!.userId` unconditionally, and a
 * session-only handler that receives an api_key request must find
 * `req.auth` undefined and fail closed, not silently coerce an api-key
 * principal into a session shape it never had.
 */
export interface ApiKeyAuthenticatedContext {
  apiKeyId: string;
  clientId: string;
  createdByUserId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedContext;
    apiKeyAuth?: ApiKeyAuthenticatedContext;
  }
}

export interface RouteConfig {
  method: HTTPMethods;
  path: string;
  /** REQUIRED - see the fail-closed-routing doc comment above. */
  policy: AuthPolicy;
  /** REQUIRED - a scope string, e.g. `'auth:login'`. */
  scope: string;
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
}

/**
 * M19 (P04a FIXB): the SAME fail-closed check as `assertValidRouteConfig`,
 * shaped as a Fastify `onRoute` hook (`server.ts` wires this in) so the
 * fail-closed-routing claim is mechanical, not conventional - it catches a
 * route that reaches Fastify WITHOUT ever calling `registerRoute` (e.g. a
 * bare `app.get(...)`), which `assertValidRouteConfig` alone cannot.
 */
export function assertRoutePolicyConfig(routeOptions: {
  method: unknown;
  url: string;
  config?: unknown;
}): void {
  const routeConfig = routeOptions.config as { policy?: unknown; scope?: unknown } | undefined;
  if (!routeConfig || !routeConfig.policy || !routeConfig.scope) {
    throw new Error(
      `route-policy: route "${String(routeOptions.method)} ${routeOptions.url}" was registered without an auth policy/scope - every route must go through route-policy.ts#registerRoute`,
    );
  }
}

function assertValidRouteConfig(config: Partial<RouteConfig>): asserts config is RouteConfig {
  const label = `${String(config.method ?? '?')} ${String(config.path ?? '?')}`;

  if (!config.policy || !VALID_POLICIES.has(config.policy)) {
    throw new Error(
      `route-policy: route "${label}" is missing a valid auth policy - every route must declare one of 'public' | 'session' | 'session_mfa' | 'session_or_api_key'`,
    );
  }
  if (!config.scope || typeof config.scope !== 'string' || config.scope.length === 0) {
    throw new Error(`route-policy: route "${label}" is missing an auth scope`);
  }
}

const API_KEY_BEARER_PREFIX = 'wp_live_';

/** Peeks the raw bearer token (if any) WITHOUT consuming it - `authenticateRequest` re-extracts it itself for the session branch, so this must never mutate `req`. */
function peekBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** Go-live U3: the `session_or_api_key` key-authenticated branch. Verifies via `verifyApiKey` and populates `req.apiKeyAuth` on success - never `req.auth` (see that field's own doc comment). Fails closed (`UnauthenticatedError`) on any rejection, including a route that never wired `deps.verifyApiKeyDeps`. */
async function enforceApiKeyBranch(
  deps: AuthDeps,
  req: FastifyRequest,
  token: string,
): Promise<void> {
  if (!deps.verifyApiKeyDeps) {
    throw new UnauthenticatedError();
  }
  const principal = await verifyApiKey(deps.verifyApiKeyDeps, token);
  if (!principal) {
    throw new UnauthenticatedError();
  }
  req.apiKeyAuth = principal;
}

async function enforcePolicy(
  deps: AuthDeps,
  policy: AuthPolicy,
  req: FastifyRequest,
): Promise<void> {
  if (policy === 'public') {
    return;
  }

  if (policy === 'session_or_api_key') {
    const bearer = peekBearerToken(req);
    if (bearer && bearer.startsWith(API_KEY_BEARER_PREFIX)) {
      await enforceApiKeyBranch(deps, req, bearer);
      return;
    }
    // Any other bearer (or none) runs the EXACT SAME session_mfa branch
    // below - never a downgrade of the MFA requirement (founder decision
    // 2026-09-14).
  }

  const { claims, mfa } = await authenticateRequest(deps, req);
  req.auth = {
    userId: claims.sub,
    sessionId: claims.sid,
    clientId: claims.clientId,
    role: claims.role,
    epoch: claims.epoch,
    ...(claims.imp ? { imp: claims.imp } : {}),
  };

  if (policy === 'session') {
    return;
  }

  // policy === 'session_mfa' (or the session_or_api_key fallthrough above)
  if (mfa) {
    return;
  }

  const hasTotp = await deps.hasTotpEnrolled(claims.sub);
  if (!hasTotp) {
    if (claims.role === 'owner') {
      throw new MfaEnrollRequiredError();
    }
    // Non-owner with no TOTP enrolled - allowed through per canon.
    return;
  }

  throw new MfaRequiredError();
}

/**
 * The ONLY way a route may reach Fastify (canon). Validates `config` BEFORE
 * touching `app` - an invalid config throws synchronously at call time
 * (i.e. at boot, before the app ever serves a request), naming the route.
 */
export function registerRoute(
  app: FastifyInstance,
  deps: AuthDeps,
  config: Partial<RouteConfig>,
): void {
  assertValidRouteConfig(config);

  app.route({
    method: config.method,
    url: config.path,
    // M19 (P04a FIXB): exposes `policy`/`scope` on the Fastify route's own
    // `config` so `server.ts`'s `onRoute` hook can mechanically verify EVERY
    // registered route went through this function - a route that bypassed
    // `registerRoute` (e.g. a bare `app.get(...)`) has no `config.policy`
    // here and fails the build.
    config: { policy: config.policy, scope: config.scope },
    handler: async (req, reply) => {
      try {
        await enforcePolicy(deps, config.policy, req);
        // P28 Unit U3c: the impersonation write ban is checked HERE, right
        // after `enforcePolicy` has populated `req.auth` - the earliest
        // point at which `req.auth.imp` is known, and unconditionally, for
        // EVERY route registered through this function (never an opt-in
        // per-route check). See impersonation-write-guard.ts's own header
        // for why this cannot be a plain Fastify `onRequest` hook instead.
        assertImpersonationWriteAllowed(req, config.method, config.path);
      } catch (err) {
        // Auth-layer failures (missing/invalid token, MFA policy denial) are
        // mapped here so EVERY route gets the standard error envelope even
        // if its own handler never runs - callers still separately map their
        // own handler-body errors (see identity.routes.ts's `guarded()`).
        sendError(reply, requestIdFor(req), err);
        return;
      }
      await config.handler(req, reply);
    },
  });
}
