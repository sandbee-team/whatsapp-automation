import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StaffAction } from '@wp/domain';
import { requestIdFor, sendError, sendSuccess } from '../../../platform/http/error-mapper.js';
import { registerRoute } from '../../../platform/http/route-policy.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import {
  assertInternalAccess,
  mapInternalError,
  parseMutationHeaders,
  sendUnauthorized,
} from '../internal-access.js';
import { computeRequestHash } from '../staff-audit.js';
import { withStaffMutation, type StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';

/**
 * routes/staff-route-shell.ts (P28 Unit U3b, step 5) - `registerStaffMutation`,
 * the ONE place the `/internal/v1` mutation GATE ORDER is written down, so
 * the nine U3b routes cannot drift from each other or from U3a's four
 * hand-written wallet routes (which established this exact order and are
 * deliberately left as-is - U3a's surface is frozen).
 *
 * GATE ORDER, unchanged from `routes/wallet.ts`:
 *  1. `assertInternalAccess(req, deps)` - IP allow-list + a service token
 *     bound to the CONCRETE `req.url` path (never a route template, see
 *     `internal-access.ts`'s own header). Failure -> 401, undistinguished.
 *  2. `parseMutationHeaders(req)` - PRESENCE of `idempotency-key`/`x-actor`
 *     only; a well-formed-but-non-staff actor is a 403 raised later inside
 *     `resolveStaffActor`, never a 400 here.
 *  3. the caller's own zod body schema - a 400 BEFORE `withStaffMutation` is
 *     entered, so a malformed request writes zero rows.
 *  4. `withStaffMutation({action, ...})` - which resolves the actor, applies
 *     `canStaff(role, action)` server-side, and writes the `staff_audit_log`
 *     row in the SAME transaction as the caller's `run`.
 *
 * The request hash covers `{method, requestPath, parsedBody}` - the PARSED
 * body, so a schema default/coercion cannot make two different wire bodies
 * hash alike, and `requestPath` is the route TEMPLATE (`computeRequestHash`'s
 * own path argument), which is what makes the same idempotency key replayed
 * against a DIFFERENT route a mismatch rather than a silent cross-route
 * replay.
 */

export interface StaffMutationRouteSpec<TBody, TResult> {
  method: 'POST' | 'PUT';
  path: string;
  /** Route-policy scope string, e.g. `internal:clients:suspend`. */
  scope: string;
  action: StaffAction;
  /**
   * A zod schema (or anything with the same `parse`). Typed as
   * `z.ZodType<TBody>` rather than `{ parse: (raw: unknown) => TBody }`: the
   * bare-function shape makes TS infer `TBody` from the PARAMETER position
   * too, which for a schema with optional members collapsed
   * `resumeInstanceInputSchema`'s output to just its optional fields and lost
   * `clientId`.
   */
  bodySchema: z.ZodType<TBody>;
  /** `client`/`instance`/`campaign` - the `staff_audit_log.target_kind` value. */
  targetKind: string;
  /** Derives the audited target ref (and, for instance/campaign routes, is where `clientId` comes from the BODY, not the path). */
  /**
   * `NoInfer` on every OTHER `TBody` position: `TBody` must be inferred from
   * `bodySchema` ALONE. Without it TS also infers from these two callbacks'
   * parameter positions and intersects the candidates, which collapsed
   * `resumeInstanceInputSchema`'s output to only its optional members
   * (`clientId` silently vanished from `body`'s type).
   */
  resolveTarget: (pathId: string, body: NoInfer<TBody>) => { clientId: string; targetRef: string };
  run: (
    tx: StaffMutationTx,
    ctx: { clientId: string; pathId: string; body: NoInfer<TBody>; deps: InternalRoutesDeps },
  ) => Promise<TResult>;
}

const pathIdSchema = z.string().uuid();

function reasonOf(body: unknown): string {
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : '';
}

/** Registers ONE `/internal/v1` staff mutation with the gate order above - see module doc. */
export function registerStaffMutation<TBody, TResult>(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  spec: StaffMutationRouteSpec<TBody, TResult>,
): void {
  registerRoute(app, authDeps, {
    method: spec.method,
    path: spec.path,
    policy: 'public',
    scope: spec.scope,
    handler: async (req: FastifyRequest, reply) => {
      const requestId = requestIdFor(req);
      try {
        assertInternalAccess(req, deps);
      } catch {
        sendUnauthorized(reply, requestId);
        return;
      }
      try {
        parseMutationHeaders(req);
        const pathId = pathIdSchema.parse((req.params as { id: string }).id);
        const body = spec.bodySchema.parse(req.body);
        const target = spec.resolveTarget(pathId, body);
        const requestHash = computeRequestHash(spec.method, spec.path, {
          pathId,
          body: body as unknown as Record<string, unknown>,
        });

        const result = await withStaffMutation(
          deps,
          req,
          {
            action: spec.action,
            clientId: target.clientId,
            targetKind: spec.targetKind,
            targetRef: target.targetRef,
            reason: reasonOf(body),
            requestHash,
          },
          (tx) => spec.run(tx, { clientId: target.clientId, pathId, body, deps }),
        );

        sendSuccess(reply, requestId, { ...result.data, replayed: result.replayed });
      } catch (err) {
        // An input-validation rejection is logged with its FIELD PATHS (never
        // the values) before the generic 400 goes back. This exists because a
        // bare `Invalid request.` envelope cost a long debugging detour in
        // P28 U3b: a schema name collision in `@wp/contracts` made the staff
        // resume route reject its own valid body, and the response carried no
        // hint at all. The response body is deliberately unchanged - no
        // field-level echo of a staff request into an error envelope.
        const issues = (err as { issues?: Array<{ path?: unknown[] }> }).issues;
        if (Array.isArray(issues)) {
          req.log.warn(
            {
              scope: spec.scope,
              fields: issues.map((issue) => (issue.path ?? []).join('.')),
            },
            'internal mutation rejected by input validation',
          );
        } else if (!(err instanceof Error) || !('code' in err)) {
          // An UNTYPED throwable becomes an opaque 500 `INTERNAL` to the
          // caller (correctly - no driver detail leaks), so its name and
          // message are logged here or they are lost entirely. A TYPED
          // `AppError` (one carrying an `ErrorCode`) is already fully
          // described by the response envelope and is not re-logged.
          req.log.error(
            {
              scope: spec.scope,
              errName: err instanceof Error ? err.name : typeof err,
              errMessage: err instanceof Error ? err.message : String(err),
            },
            'internal mutation failed',
          );
        }
        sendError(reply, requestId, mapInternalError(err));
      }
    },
  });
}
