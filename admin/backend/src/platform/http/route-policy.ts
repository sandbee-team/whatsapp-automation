import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { StaffAction, StaffRole } from '@wp/domain';
import { canStaff } from '@wp/domain';
import { requestIdFor, sendError } from './error-mapper.js';
import { authenticateStaff, type StaffAuthDeps } from './staff-auth-plugin.js';

/**
 * platform/http/route-policy.ts (P28 Unit U4, step 6) - FAIL-CLOSED ROUTING
 * for admin-backend, the same mechanical shape app-backend's own
 * `route-policy.ts` established: every route MUST be registered through
 * `registerAdminRoute` declaring an explicit `policy`, and a route that
 * reaches Fastify without one THROWS AT BOOT naming the offender.
 *
 * Two hooks, deliberately both:
 *  - `assertValidRouteConfig` catches a bad call to THIS function;
 *  - `assertAdminRoutePolicy` (wired as Fastify's `onRoute` hook in
 *    `server.ts`) catches a route that never called this function at all
 *    (e.g. a bare `app.get(...)`), which the first check structurally
 *    cannot see.
 * On an admin panel with cross-tenant read access, "someone forgot the auth
 * decorator" must be a build failure, not a security incident.
 *
 * A `'staff'` route additionally REQUIRES an `action`: authentication and
 * authorization are declared together, so there is no such thing as an
 * authenticated-but-unauthorized-by-default admin route. The RBAC check is
 * re-run server-side from the token's role (`canStaff`) - the panel's own
 * greying-out of buttons is a UX affordance, never the authority.
 */

export type AdminAuthPolicy = 'public' | 'staff';

export interface AdminStaffContext {
  staffId: string;
  role: StaffRole;
  fullName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff?: AdminStaffContext;
  }
}

export class StaffForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'This staff account may not perform this action.') {
    super(message);
    this.name = 'StaffForbiddenError';
  }
}

export interface AdminRouteConfig {
  method: HTTPMethods;
  path: string;
  /** REQUIRED - see the fail-closed doc comment above. */
  policy: AdminAuthPolicy;
  /** REQUIRED when `policy === 'staff'`: the `StaffAction` this route needs. */
  action?: StaffAction;
  /** Optional per-route body size cap in bytes, passed straight to Fastify's own `bodyLimit`; additive - omitting it keeps Fastify's default (1 MiB). */
  bodyLimit?: number;
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void> | void;
}

/** Fastify `onRoute` hook - catches any route that bypassed `registerAdminRoute` entirely. */
export function assertAdminRoutePolicy(routeOptions: {
  method: unknown;
  url: string;
  config?: unknown;
}): void {
  const routeConfig = routeOptions.config as { policy?: unknown } | undefined;
  if (!routeConfig?.policy) {
    throw new Error(
      `route-policy: route "${String(routeOptions.method)} ${routeOptions.url}" was registered without an auth policy - every admin route must go through route-policy.ts#registerAdminRoute`,
    );
  }
}

function assertValidRouteConfig(
  config: Partial<AdminRouteConfig>,
): asserts config is AdminRouteConfig {
  const label = `${String(config.method ?? '?')} ${String(config.path ?? '?')}`;
  if (config.policy !== 'public' && config.policy !== 'staff') {
    throw new Error(
      `route-policy: route "${label}" is missing a valid auth policy - declare 'public' or 'staff'`,
    );
  }
  if (config.policy === 'staff' && !config.action) {
    throw new Error(
      `route-policy: staff route "${label}" declares no StaffAction - authentication and authorization are declared together`,
    );
  }
}

/** Server-side RBAC re-check (never trust what the panel greys out) - throws 403 when `role` may not perform `action`. */
export function assertStaffCan(req: FastifyRequest, action: StaffAction): void {
  const staff = req.staff;
  if (!staff || !canStaff(staff.role, action)) {
    throw new StaffForbiddenError();
  }
}

/** The ONLY way a route may reach Fastify in admin-backend (see module header). */
export function registerAdminRoute(
  app: FastifyInstance,
  deps: StaffAuthDeps,
  config: Partial<AdminRouteConfig>,
): void {
  assertValidRouteConfig(config);

  app.route({
    method: config.method,
    url: config.path,
    ...(config.bodyLimit !== undefined ? { bodyLimit: config.bodyLimit } : {}),
    config: { policy: config.policy, action: config.action },
    handler: async (req, reply) => {
      try {
        if (config.policy === 'staff') {
          req.staff = await authenticateStaff(deps, req);
          assertStaffCan(req, config.action as StaffAction);
        }
      } catch (err) {
        // Auth-layer failures get the standard envelope even though the
        // route's own handler never runs.
        sendError(reply, requestIdFor(req), err);
        return;
      }
      try {
        await config.handler(req, reply);
      } catch (err) {
        sendError(reply, requestIdFor(req), err);
      }
    },
  });
}
