import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { maskPhoneE164 } from '@wp/domain';
import type { TenantDb, TenantQueryable } from '@wp/db';
import { sendError } from '../../platform/http/error-mapper.js';
import type { GuardDeps } from '../../platform/http/guards.js';
import type { InstanceCtx } from './repo.js';
import * as reads from './instance-reads.repo.js';

/**
 * instances.routes-support.ts (P08 Unit U6c) - typed error classes + small
 * shared helpers `instances.routes.ts` uses across all six routes, split
 * out for max-lines discipline. Not a public module surface (not exported
 * from `index.ts`) - `instances.routes.ts` is the only importer.
 */

export class InstanceNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such WhatsApp instance.');
    this.name = 'InstanceNotFoundError';
  }
}

export class RegisteredLimitReachedError extends Error {
  readonly code = 'REGISTERED_LIMIT_REACHED';
  constructor() {
    super('This plan has reached its registered-instance limit.');
    this.name = 'RegisteredLimitReachedError';
  }
}

export class InvalidStateError extends Error {
  readonly code = 'INVALID_STATE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateError';
  }
}

export interface NoFreeSlotHolder {
  instanceId: string;
  label: string | null;
  maskedNumber: string | null;
}

export class NoFreeSlotError extends Error {
  readonly code = 'NO_FREE_SLOT';
  readonly details: { holders: NoFreeSlotHolder[] };
  constructor(holders: NoFreeSlotHolder[]) {
    super('This plan has no free connected-instance slot.');
    this.name = 'NoFreeSlotError';
    this.details = { holders };
  }
}

export class ValidationMappedError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationMappedError';
  }
}

/**
 * FINDING 7 FIX (P13 C1 review): `tenantDb` - added so `POST /v1/instances`
 * can wrap `createInstance` + `provisionInstancePacingState` + the audit
 * write in ONE transaction (see `instances.routes.ts`'s own handler for
 * the full rationale: a crash between the two former separate statements
 * left an instance with `deleted_at IS NULL` and no pacing state, which
 * `assertNoLiveInstanceIsMissingPacingState` then refuses to boot the
 * entire session-worker role over). Same shape as `modules/messages/
 * messages.routes-support.ts`'s own `tenantDb` field - `roles/api.ts`
 * wires both from the SAME `createTenantDb(pool)` call.
 *
 * `publishDiscoveryWake` (2026-09-17, "QR takes 3-12s to appear" fix) -
 * `link.routes.ts`'s ONLY consumer, called AFTER `/link`'s pairing-intent
 * transaction commits (`engine/fleet/discovery-wake.ts`'s own doc comment
 * explains why this must be fleet-wide, not the per-instance `wake.ts`
 * channel). Optional + defaulted to a no-op so every existing test fixture
 * that builds `InstancesRoutesDeps` without it keeps compiling unchanged -
 * `roles/api.ts` always supplies the real one in production.
 */
export type InstancesRoutesDeps = GuardDeps & {
  tenantDb: TenantDb;
  publishDiscoveryWake?: () => Promise<void> | void;
};

/**
 * Runs `fn` inside ONE `tenantDb.withTenant` transaction and hands it an
 * `InstanceCtx` bound to that transaction.
 *
 * THIS REPLACED A BARE-POOL HELPER, AND THE REASON MATTERS (2026-09-14).
 * `sqlFor()` used to hand out `deps.entitlementCtx.pool` cast to a
 * `TenantQueryable`, with a doc comment claiming that because every query is
 * `client_id`-scoped in its WHERE clause and FORCE-RLS-enforced under
 * `wp_app`, "no per-request GUC transaction is needed". That reasoning is
 * wrong, and it was wrong in both directions:
 *
 *   - A `USING` predicate fails SOFT. Under `wp_app` with no
 *     `app.client_id` set, `SELECT ... FROM whatsapp_instances` returns ZERO
 *     ROWS - so `loadOwnedOrNotFound` 404s an instance the tenant really
 *     owns, and `readPlanLimits`/`readLinkStatus` silently read nothing.
 *   - A `WITH CHECK` predicate fails HARD. `INSERT INTO audit_logs` raises
 *     SQLSTATE 42501 ("new row violates row-level security policy"), so
 *     park/link/online return 500 and write no audit row.
 *
 * Both were reproduced against the real database under `SET LOCAL ROLE
 * wp_app`, and both disappear the moment `set_config('app.client_id', …)`
 * runs first - which is exactly what `withTenant` does. Every test missed it
 * because dev/test connects as the RLS-BYPASSING superuser (`pg_roles`:
 * `wp` has `rolbypassrls = t`, `wp_app` has `f`). This is the FOURTH
 * occurrence of that class in this repo - see
 * `.memory/lessons/2026-09-11-superuser-dev-db-hides-force-rls-zero-row-reads.md`.
 *
 * There is deliberately no `sqlFor`/`ctxFor` escape hatch any more: a helper
 * that hands out a bare pool typed as `TenantQueryable` is exactly how this
 * defect got written, so the only way to get an `InstanceCtx` is now inside
 * a real tenant transaction.
 */
export function withInstanceCtx<T>(
  deps: InstancesRoutesDeps,
  clientId: string,
  fn: (ctx: InstanceCtx, tx: TenantQueryable) => Promise<T>,
): Promise<T> {
  return deps.tenantDb.withTenant(clientId, (tx) =>
    fn({ clientId, sql: tx as unknown as InstanceCtx['sql'] }, tx),
  );
}

export function maskedOrNull(phoneE164: string | null): string | null {
  return phoneE164 ? maskPhoneE164(phoneE164) : null;
}

export async function guarded(
  reply: FastifyReply,
  requestId: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const mapped =
      err instanceof z.ZodError ? new ValidationMappedError('Invalid request body.') : err;
    sendError(reply, requestId, mapped);
  }
}

/** Loads the instance's own client-scoped link-status row, or throws 404 - the shared ownership-scoping step every `:id` route runs first. */
export async function loadOwnedOrNotFound(
  ctx: InstanceCtx,
  instanceId: string,
): Promise<reads.LinkStatus> {
  const status = await reads.readLinkStatus(ctx, instanceId);
  if (!status) throw new InstanceNotFoundError();
  return status;
}

export function instanceIdFrom(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}
