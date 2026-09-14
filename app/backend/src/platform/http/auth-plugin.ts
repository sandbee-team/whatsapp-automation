import { decodeJwt } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { TenantQueryable } from '@wp/db';
import {
  validateAccessToken,
  UnauthenticatedError,
  type AccessTokenClaims,
  type TokenEpochCtx,
} from '../../modules/identity/token-epoch.js';
import type { VerifyApiKeyDeps } from '../../modules/api-keys/verify.js';

/**
 * platform/http/auth-plugin.ts (P04a Unit UA6) - the bearer-token
 * authentication primitive route-policy.ts's `session`/`session_mfa` policies
 * build on. No fallback identity anywhere (core invariant): a missing/invalid
 * `Authorization` header on a non-public route always throws
 * `UnauthenticatedError`, never substitutes a default user.
 */

export interface AuthDeps {
  tokenEpochCtx: TokenEpochCtx;
  /** Plain connection/pool - `users` carries no client_id/RLS (identity is global). */
  db: TenantQueryable;
  /**
   * Resolves whether `userId` has completed TOTP enrolment - injected rather
   * than importing `modules/identity/identity.repo.ts` directly, so
   * `platform/http/**` never reaches into a module's internals (layering
   * rule: other code imports only a module's `index.ts`).
   */
  hasTotpEnrolled: (userId: string) => Promise<boolean>;
  /**
   * Go-live U3: backs `route-policy.ts`'s `session_or_api_key` policy's
   * key-authenticated branch. Optional because most routes never declare
   * that policy - `assertValidRouteConfig` never requires it, and a route
   * that DOES declare `session_or_api_key` without wiring this dep will
   * simply throw when a `wp_live_`-prefixed bearer is presented (fail
   * closed, never a silent fallback).
   */
  verifyApiKeyDeps?: VerifyApiKeyDeps;
}

export interface AuthenticatedRequest {
  claims: AccessTokenClaims;
  /**
   * The access token's own `mfa` claim, peeked via an UNVERIFIED decode
   * (`jose`'s `decodeJwt`) - safe here only because `validateAccessToken` has
   * ALREADY cryptographically verified the same token's signature/expiry/
   * epoch immediately before this call; this step exists purely to read one
   * extra claim `validateAccessToken`'s own return type does not carry.
   */
  mfa: boolean;
}

function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/** Authenticates `req` against `deps`, or throws `UnauthenticatedError` - never a fallback identity. */
export async function authenticateRequest(
  deps: AuthDeps,
  req: FastifyRequest,
): Promise<AuthenticatedRequest> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new UnauthenticatedError();
  }

  const claims = await validateAccessToken(deps.tokenEpochCtx, token);

  let mfa: boolean;
  try {
    const payload = decodeJwt(token);
    mfa = payload.mfa === true;
  } catch {
    mfa = false;
  }

  return { claims, mfa };
}
