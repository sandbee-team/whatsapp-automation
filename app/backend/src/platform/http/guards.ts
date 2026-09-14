import type { FastifyRequest } from 'fastify';
import {
  assertCanConnect,
  assertCanSend,
  type EntitlementCtx,
} from '../../modules/tenancy/index.js';
import type { AuthenticatedContext } from './route-policy.js';

/**
 * platform/http/guards.ts (P04b Unit UB1b, phase step 7) - a thin helper a
 * route handler calls to enforce the entitlement gate (`modules/tenancy`'s
 * `assertCanConnect`/`assertCanSend`). Deliberately thin: policy/scope
 * enforcement (authentication, MFA) stays entirely in `route-policy.ts`; this
 * only decides "is this AUTHENTICATED caller entitled to do this business
 * action", and lets its typed errors (EmailNotVerifiedError,
 * EntitlementDeniedError) flow straight up to the handler's own `guarded()`/
 * error-mapper - it never catches them itself.
 */

export interface GuardDeps {
  entitlementCtx: EntitlementCtx;
}

function inputFrom(auth: AuthenticatedContext): { clientId: string; userId: string } {
  return { clientId: auth.clientId, userId: auth.userId };
}

/** Throws (EmailNotVerifiedError | EntitlementDeniedError) if `req.auth` may not reach the Connect-WhatsApp flow. */
export async function requireCanConnect(deps: GuardDeps, req: FastifyRequest): Promise<void> {
  const auth = req.auth!;
  await assertCanConnect(deps.entitlementCtx, inputFrom(auth));
}

/**
 * Go-live U3: the entitlement check itself, lifted out of `requireCanSend`
 * so an api-key principal (`session_or_api_key` routes) can call it
 * directly. An api key inherits its CREATOR's entitlement (`createdByUserId`
 * from `modules/api-keys/verify.ts`'s principal) - a de-verified or
 * suspended tenant's keys stop working exactly like its logged-in sessions
 * would, never a separate/looser check.
 */
export async function requireCanSendForPrincipal(
  deps: GuardDeps,
  principal: { clientId: string; userId: string },
): Promise<void> {
  await assertCanSend(deps.entitlementCtx, principal);
}

/** Throws (EmailNotVerifiedError | EntitlementDeniedError) if `req.auth` may not send. See assertCanSend's own doc comment for its P04b scope. */
export async function requireCanSend(deps: GuardDeps, req: FastifyRequest): Promise<void> {
  await requireCanSendForPrincipal(deps, inputFrom(req.auth!));
}
