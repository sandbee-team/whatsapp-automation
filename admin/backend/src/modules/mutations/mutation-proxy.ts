import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StaffAction } from '@wp/domain';
import type { ZodType } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { callInternal, type InternalClientDeps } from '../internal-client/internal-client.js';

/**
 * modules/mutations/mutation-proxy.ts (P28 Unit U4, step 8) - the ONE shape
 * every admin mutation takes. There is deliberately no per-route mutation
 * code: a mutation route is a declaration (path, action, internal path
 * builder, input schema), and this module supplies the whole pipeline.
 *
 * THE PIPELINE, in order, none of it skippable:
 *  1. `'staff'` policy -> authenticate + `assertStaffCan(action)`. The panel
 *     greys out buttons; THIS is the authority. app-backend then re-checks
 *     the same action a THIRD time from the `X-Actor` header, because a
 *     compromised admin process must not be able to grant itself rights.
 *  2. VALIDATE with the `internalContract` input schema - the same schema
 *     app-backend validates against, imported rather than re-declared, so
 *     the two cannot drift. `reason` is mandatory in every one of those
 *     schemas, so a reasonless mutation is a 400 here and structurally
 *     impossible downstream (`staff_audit_log.reason` is NOT NULL with a
 *     non-blank CHECK).
 *  3. IDEMPOTENCY KEY: the panel's `Idempotency-Key` header is passed
 *     through UNCHANGED. When absent, ONE is generated per request and
 *     reused across this call's own retries. Passing the panel's key
 *     through is what makes a user's "did that go through?" retry safe: the
 *     same key replays the original outcome instead of applying the action
 *     twice (the authority is a UNIQUE constraint on
 *     `staff_audit_log.idempotency_key`, never an in-memory check).
 *  4. `callInternal` -> app-backend's `/internal/v1`, which owns the write.
 *     admin-backend has no grant to make any of these changes itself (ADR
 *     0014 fact 1/12), so this is not a policy choice that could be
 *     shortcut - the database would refuse it.
 */

export interface MutationProxyDeps {
  internal: InternalClientDeps;
  auth: StaffAuthDeps;
}

export interface MutationRouteSpec<TOut> {
  method: 'POST' | 'PUT';
  /** The ADMIN path, with Fastify params, e.g. `/admin/v1/clients/:id/suspend`. */
  path: string;
  action: StaffAction;
  /** Builds the CONCRETE `/internal/v1` path from the request's own params - never a template (the HMAC binds the concrete path). */
  internalPath: (params: Record<string, string>) => string;
  /** The matching `internalContract` INPUT schema - imported, never re-declared. */
  inputSchema: ZodType;
  /** The matching `internalContract` OUTPUT schema, used to parse the success envelope's `data`. */
  outputSchema: ZodType<TOut>;
  /** Optional response shaper - e.g. impersonation's `panelUrl` assembly. */
  shapeResponse?: (data: TOut) => unknown;
}

/**
 * The panel sends one uuid per USER ACTION. Generating a fresh one here when
 * the header is absent is a fallback, not the norm: a generated key makes
 * THIS request's retries safe but cannot deduplicate a second click, which
 * is exactly why the panel is the right place to mint it.
 */
function idempotencyKeyOf(req: FastifyRequest): string {
  const header = req.headers['idempotency-key'];
  return typeof header === 'string' && header.trim().length >= 8
    ? header.trim()
    : `admin-${randomUUID()}`;
}

function paramsOf(req: FastifyRequest): Record<string, string> {
  return (req.params ?? {}) as Record<string, string>;
}

/** Registers ONE mutation proxy from its declaration (see the module header's pipeline). */
export function registerMutationProxy<TOut>(
  app: FastifyInstance,
  deps: MutationProxyDeps,
  spec: MutationRouteSpec<TOut>,
): void {
  registerAdminRoute(app, deps.auth, {
    method: spec.method,
    path: spec.path,
    policy: 'staff',
    action: spec.action,
    handler: async (req, reply) => {
      // Throws ZodError -> 400 VALIDATION_ERROR before anything is called.
      const body = spec.inputSchema.parse(req.body ?? {});
      const data = await callInternal(deps.internal, {
        method: spec.method,
        path: spec.internalPath(paramsOf(req)),
        actor: { staffId: req.staff!.staffId },
        idempotencyKey: idempotencyKeyOf(req),
        body,
        outputSchema: spec.outputSchema,
      });
      sendSuccess(reply, requestIdFor(req), spec.shapeResponse ? spec.shapeResponse(data) : data);
    },
  });
}

/** Registers a whole group of mutation proxies - the only way these routes reach Fastify. */
export function registerMutationProxies(
  app: FastifyInstance,
  deps: MutationProxyDeps,
  specs: Array<MutationRouteSpec<never>>,
): void {
  for (const spec of specs) {
    registerMutationProxy(app, deps, spec);
  }
}
