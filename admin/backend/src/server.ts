import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { assertAdminRoutePolicy, registerAdminRoute } from './platform/http/route-policy.js';
import { requestIdFor, sendSuccess } from './platform/http/error-mapper.js';
import type { StaffAuthDeps } from './platform/http/staff-auth-plugin.js';
import type { PlatformReadDeps } from './platform/platform-read.js';
import { registerStaffAuthRoutes, type StaffAuthRoutesDeps } from './modules/staff-auth/routes.js';
import { registerClientsRoutes } from './modules/clients/clients.routes.js';
import { registerInstancesRoutes } from './modules/instances/instances.routes.js';
import { registerQueueRoutes } from './modules/queue/queue.routes.js';
import { registerWalletRoutes } from './modules/wallet/wallet.routes.js';
import { registerAuditRoutes } from './modules/audit/audit.routes.js';
import { registerTopupsRoutes } from './modules/topups/topups.routes.js';
import { registerPlansRoutes } from './modules/plans/plans.routes.js';
import { registerMutationRoutes } from './modules/mutations/mutations.routes.js';
import type { ImpersonationMutationDeps } from './modules/mutations/impersonation.routes.js';
import { registerLeadsRoutes, type LeadsRoutesDeps } from './modules/leads/leads.routes.js';

/**
 * server.ts (P28 Unit U4, steps 6-7) - assembles the admin Fastify app.
 *
 * Two things here are load-bearing rather than boilerplate:
 *
 *  1. `app.addHook('onRoute', assertAdminRoutePolicy)` - FAIL-CLOSED
 *     ROUTING. Any route reaching Fastify without an auth policy throws AT
 *     BOOT, including one that bypassed `registerAdminRoute` entirely (a
 *     bare `app.get(...)`). On a surface with cross-tenant read access,
 *     "someone forgot the auth wrapper" must be a build failure, never a
 *     runtime discovery.
 *
 *  2. `trustProxy` is CONFIG-DRIVEN and defaults to false. `req.ip` is what
 *     the login route's IP allow-list checks, so a hard-coded `true` would
 *     let any caller spoof an allow-listed source address via
 *     `X-Forwarded-For` and walk straight past it. Only a deployment that
 *     actually terminates TLS behind a trusted proxy should set it.
 */

export interface BuildAdminAppDeps {
  read: PlatformReadDeps;
  auth: StaffAuthDeps;
  staffAuth: StaffAuthRoutesDeps;
  trustProxy: boolean;
  /**
   * Optional (steps 8/10): the mutation proxies. ABSENT means the routes are
   * not registered at all - a 404, not a 403 - which is what an
   * integration test wanting a read-only app gets. Same "optional dep, no
   * route until wired" idiom app-backend's `BuildAppDeps` uses throughout.
   */
  mutations?: ImpersonationMutationDeps;
  /**
   * Optional: the public lead-form endpoint (P29 U4b). ABSENT means the
   * route is not registered at all, same "optional dep, no route until
   * wired" idiom as `mutations` above.
   */
  leads?: LeadsRoutesDeps;
}

export async function buildAdminApp(deps: BuildAdminAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: deps.trustProxy });
  await app.register(cookie);
  app.addHook('onRoute', assertAdminRoutePolicy);

  registerAdminRoute(app, deps.auth, {
    method: 'GET',
    path: '/admin/v1/health/ping',
    policy: 'public',
    handler: (req, reply) => {
      // Deliberately reveals nothing but liveness - no version, no schema
      // number, no build id: this is the one unauthenticated route, so it
      // must not be a fingerprinting surface.
      sendSuccess(reply, requestIdFor(req), { ok: true });
    },
  });

  registerStaffAuthRoutes(app, deps.staffAuth);

  const readDeps = { read: deps.read, auth: deps.auth };
  registerClientsRoutes(app, readDeps);
  registerInstancesRoutes(app, readDeps);
  registerQueueRoutes(app, readDeps);
  registerWalletRoutes(app, readDeps);
  registerAuditRoutes(app, readDeps);
  registerTopupsRoutes(app, readDeps);
  registerPlansRoutes(app, readDeps);

  if (deps.mutations) {
    registerMutationRoutes(app, deps.mutations);
  }

  if (deps.leads) {
    registerLeadsRoutes(app, deps.leads);
  }

  return app;
}
