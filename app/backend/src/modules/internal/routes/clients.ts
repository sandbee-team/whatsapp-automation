import type { FastifyInstance } from 'fastify';
import {
  suspendClientInputSchema,
  reactivateClientInputSchema,
  setClientPricingInputSchema,
  setClientPlanInputSchema,
} from '@wp/contracts';
import { materialiseMaxRate, publishWakeForClient } from '../../wallet/index.js';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { StaffMutationTx } from '../with-staff-mutation.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { InternalInvalidStateError, InternalTargetNotFoundError } from './internal-errors.js';
import { registerStaffMutation } from './staff-route-shell.js';
import { registerInternalClientLimitsRoutes } from './clients-limits.js';
import { resolvePlanId } from './clients-plan.js';

/**
 * routes/clients.ts (P28 Unit U3b, step 5) - the staff CLIENT-level
 * mutations: `POST clients/:id/{suspend,reactivate}` and
 * `PUT clients/:id/{pricing,plan}`. `PUT clients/:id/limits` lives in the
 * `clients-limits.ts` sibling (300-line cap split, same idiom as
 * `session-worker-discovery-wiring.ts`), and is registered from this file's
 * own `registerInternalClientRoutes` so `index.ts` has ONE call per area.
 *
 * SUSPEND IS NOT A DELETE (core invariant 5): the only write is the ONE
 * conditional `clients.status` UPDATE below. `db/queries/claim-jobs.sql`
 * already INNER JOINs `clients` with `AND c.status = 'active'`, so a
 * suspension stops CLAIMING through the existing send-path predicate - no
 * job row is failed, cancelled, deleted or even read by this route. That is
 * why there is no "cancel the queue" step here and must never be one.
 *
 * STATE MACHINE (staff may only move `active <-> suspended`):
 * `pending_verification` and `closed` are NEVER touched - a zero-row UPDATE
 * is reported as `changed:false` when the row is ALREADY in the target state
 * (an idempotent no-op, core invariant 3), and as 409 `INVALID_STATE`
 * otherwise, which is what keeps a `closed` account from being silently
 * revived by a suspend/reactivate pair.
 *
 * PRICING WRITES TWO ROWS IN ONE TRANSACTION (ADR 0019 S11): the
 * `client_pricing.override_items` UPDATE and `materialiseMaxRate`'s
 * `wallet_accounts.max_rate_minor` rewrite MUST commit together, or
 * `claim-jobs.sql`'s `balance_minor >= max_rate_minor` predicate would admit
 * a client at the OLD rate on the very next claim.
 */

const CLIENT_TARGET = 'client';

interface StatusRow extends Record<string, unknown> {
  status: string;
}

/**
 * The ONE conditional `clients.status` transition (see module doc). Returns
 * `changed:false` for an already-in-target-state row, and throws 409 for any
 * other current status - the read below runs only when the UPDATE matched
 * nothing, so the happy path is a single statement.
 */
async function transitionClientStatus(
  tx: StaffMutationTx,
  clientId: string,
  from: string,
  to: string,
): Promise<{ changed: boolean }> {
  const updated = await tx.query(
    `UPDATE clients SET status = $3, updated_at = now()
      WHERE id = $1 AND status = $2
      -- client_id = id = $1`,
    [clientId, from, to],
  );
  if ((updated.rowCount ?? 0) > 0) {
    return { changed: true };
  }

  const current = await tx.query<StatusRow>(
    `SELECT status FROM clients WHERE id = $1
      -- client_id = id = $1`,
    [clientId],
  );
  const status = current.rows[0]?.status;
  if (status === undefined) {
    throw new InternalTargetNotFoundError('No such client.');
  }
  if (status === to) {
    return { changed: false };
  }
  throw new InternalInvalidStateError(
    `This client is ${status}; staff may only move a client between active and suspended.`,
  );
}

function registerSuspendOrReactivate(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
  mode: 'suspend' | 'reactivate',
): void {
  const isSuspend = mode === 'suspend';

  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: `/internal/v1/clients/:id/${mode}`,
    scope: `internal:clients:${mode}`,
    action: isSuspend ? 'clients.suspend' : 'clients.reactivate',
    bodySchema: isSuspend ? suspendClientInputSchema : reactivateClientInputSchema,
    targetKind: CLIENT_TARGET,
    resolveTarget: (pathId) => ({ clientId: pathId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const { changed } = await transitionClientStatus(
        tx,
        ctx.clientId,
        isSuspend ? 'active' : 'suspended',
        isSuspend ? 'suspended' : 'active',
      );

      let wokenInstances = 0;
      if (changed) {
        await notify(tx, {
          clientId: ctx.clientId,
          kind: isSuspend ? 'client_suspended' : 'client_reactivated',
          transitionId: String(tx.auditId),
          payload: {},
        });

        if (!isSuspend) {
          // A reactivate turns a zero-claim state into a claimable one for
          // EVERY instance of this client, so it publishes a wake per
          // non-deleted instance - through `publishWakeForClient`, the one
          // and only multi-instance wake publisher (see its own header:
          // "there is no second wake publisher"). Counted here, inside the
          // transaction, from the same predicate that publisher uses, so the
          // response's `wokenInstances` matches what actually gets woken.
          const instances = await tx.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM whatsapp_instances
              WHERE client_id = $1 AND deleted_at IS NULL`,
            [ctx.clientId],
          );
          wokenInstances = Number(instances.rows[0]?.n ?? '0');
          tx.afterCommit(() =>
            ctx.deps.tenantDb.withTenant(ctx.clientId, (readTx) =>
              publishWakeForClient({ db: readTx, publishWake: ctx.deps.publishWake }, ctx.clientId),
            ),
          );
        }
      }

      return isSuspend
        ? { clientId: ctx.clientId, status: 'suspended', changed }
        : { clientId: ctx.clientId, status: 'active', changed, wokenInstances };
    },
  });
}

function registerPricingRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'PUT',
    path: '/internal/v1/clients/:id/pricing',
    scope: 'internal:clients:pricing',
    action: 'clients.pricing',
    bodySchema: setClientPricingInputSchema,
    targetKind: CLIENT_TARGET,
    resolveTarget: (pathId) => ({ clientId: pathId, targetRef: pathId }),
    run: async (tx, ctx) => {
      const updated = await tx.query(
        `UPDATE client_pricing SET override_items = $2::jsonb, updated_at = now()
          WHERE client_id = $1`,
        [ctx.clientId, JSON.stringify(ctx.body.overrideItems)],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new InternalTargetNotFoundError('This client has no pricing row.');
      }

      // SAME TRANSACTION as the override write (module doc / ADR 0019 S11).
      const maxRateMinor = await materialiseMaxRate(tx, ctx.clientId);

      await notify(tx, {
        clientId: ctx.clientId,
        kind: 'pricing_changed',
        transitionId: String(tx.auditId),
        payload: { maxRateMinor: String(maxRateMinor) },
      });

      return {
        clientId: ctx.clientId,
        maxRateMinor: String(maxRateMinor),
        overrideItems: ctx.body.overrideItems,
      };
    },
  });
}

function registerPlanRoute(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'PUT',
    path: '/internal/v1/clients/:id/plan',
    scope: 'internal:clients:plan',
    action: 'clients.plan',
    bodySchema: setClientPlanInputSchema,
    targetKind: CLIENT_TARGET,
    resolveTarget: (pathId) => ({ clientId: pathId, targetRef: pathId }),
    run: async (tx, ctx) => {
      // Resolve the plan id FIRST, hard 404 on no match - see
      // `clients-plan.ts`'s own header for why the old inline subquery
      // could silently write `plan_id = NULL` instead.
      const planId = await resolvePlanId(tx, ctx.body.planKey);

      const updated = await tx.query(
        `UPDATE clients SET plan_id = $2, updated_at = now()
          WHERE id = $1
          -- client_id = id = $1`,
        [ctx.clientId, planId],
      );
      if ((updated.rowCount ?? 0) === 0) {
        throw new InternalTargetNotFoundError('No such client.');
      }

      // `limits_changed` covers BOTH plan and per-limit-override changes -
      // from a tenant's point of view a plan change IS a limits change, and
      // a second kind for it would fan out two notices for one event.
      await notify(tx, {
        clientId: ctx.clientId,
        kind: 'limits_changed',
        transitionId: String(tx.auditId),
        payload: { planKey: ctx.body.planKey },
      });

      return { clientId: ctx.clientId, planKey: ctx.body.planKey };
    },
  });
}

export function registerInternalClientRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerSuspendOrReactivate(app, deps, authDeps, 'suspend');
  registerSuspendOrReactivate(app, deps, authDeps, 'reactivate');
  registerPricingRoute(app, deps, authDeps);
  registerPlanRoute(app, deps, authDeps);
  registerInternalClientLimitsRoutes(app, deps, authDeps);
}
