import type { FastifyRequest } from 'fastify';

/**
 * platform/http/impersonation-write-guard.ts (P28 Unit U3c) - the
 * route-layer block on an impersonation session. `route-policy.ts#
 * registerRoute` calls `assertImpersonationWriteAllowed` right after
 * `enforcePolicy` has populated `req.auth` (the earliest point `req.auth.imp`
 * is known), for EVERY route registered through it - never an opt-in check a
 * route can forget to add. A plain Fastify `onRequest` hook cannot do this:
 * `enforcePolicy` runs INSIDE `registerRoute`'s own Fastify `handler`, not as
 * a separate hook, so `req.auth` does not exist yet at `onRequest` time.
 *
 * An impersonation session (`req.auth.imp` set) may only ever GET/HEAD, plus
 * the three explicitly allow-listed mutations below - every other mutation
 * is refused BEFORE the route's own handler body runs, so nothing is ever
 * written under a staff-impersonated session except through this narrow,
 * audited allow-list.
 */

export class ImpersonatedSessionReadOnlyError extends Error {
  readonly code = 'FORBIDDEN';
  readonly details = { reason: 'impersonated_session_is_read_only' };
  constructor() {
    super('This action is not available during an impersonated session.');
    this.name = 'ImpersonatedSessionReadOnlyError';
  }
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** `METHOD path` pairs (the route's own REGISTERED template, e.g. `/v1/notifications/:id/read`) an impersonation session MAY still call - see module doc. */
const ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  'POST /v1/auth/logout',
  'POST /v1/auth/impersonation/refresh',
  'POST /v1/notifications/:id/read',
  'POST /v1/notifications/read-all',
]);

/** The minimal Fastify surface this boot check needs - never the whole `FastifyInstance` type, so a fake in a unit test needs no other Fastify machinery. */
export interface RouteRegistry {
  hasRoute(opts: { method: string; url: string }): boolean;
}

/**
 * Boot-time check (C1 review round 2 MINOR fix): throws if any
 * `ALLOWED_MUTATIONS` entry names a route template Fastify never actually
 * registered - a typo'd or renamed template would otherwise silently stop
 * protecting anything (`assertImpersonationWriteAllowed`'s own lookup would
 * just never match that key, indistinguishable from "correctly refused").
 * `server.ts` calls this once, after every route has been registered.
 *
 * `isEntryOptional` (default: none are) lets a caller that deliberately
 * builds a PARTIAL app (every existing internal-routes test harness passes
 * only the `deps.*` groups it needs - `deps.notifications` is commonly
 * absent) skip an entry whose owning module was never wired in THIS build,
 * without weakening the check for a build that wires everything (production
 * `buildApp` never sets this).
 */
export function assertImpersonationAllowListRegistered(
  app: RouteRegistry,
  isEntryOptional: (entry: string) => boolean = () => false,
): void {
  for (const entry of ALLOWED_MUTATIONS) {
    const spaceIndex = entry.indexOf(' ');
    const method = entry.slice(0, spaceIndex);
    const url = entry.slice(spaceIndex + 1);
    if (!app.hasRoute({ method, url }) && !isEntryOptional(entry)) {
      throw new Error(
        `impersonation-write-guard: ALLOWED_MUTATIONS entry "${entry}" does not match any registered route - fix the entry or the route template.`,
      );
    }
  }
}

/** Throws `ImpersonatedSessionReadOnlyError` when `req`'s already-authenticated principal is an impersonation session and `method`/`routePath` (the route's own registered template) is not on the allow-list. A no-op for any non-impersonation request or a `public`-policy route (no `req.auth` at all). */
export function assertImpersonationWriteAllowed(
  req: FastifyRequest,
  method: string | undefined,
  routePath: string | undefined,
): void {
  if (!method || READ_METHODS.has(method)) return;
  const imp = req.auth?.imp;
  if (!imp) return;

  const key = `${method} ${routePath ?? ''}`;
  if (ALLOWED_MUTATIONS.has(key)) return;

  throw new ImpersonatedSessionReadOnlyError();
}
