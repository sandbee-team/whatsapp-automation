import type { FastifyInstance } from 'fastify';
import { cancelCampaignInputSchema } from '@wp/contracts';
import { cancelBroadcastInTx, runCancelBookkeepingBatch } from '../../broadcasts/index.js';
import { notify } from '../../notifications/index.js';
import type { AuthDeps } from '../../../platform/http/auth-plugin.js';
import type { InternalRoutesDeps } from '../internal-routes-deps.js';
import { registerStaffMutation } from './staff-route-shell.js';

/**
 * routes/campaigns.ts (P28 Unit U3b, step 5) -
 * `POST /internal/v1/campaigns/:id/cancel`, the one broadcast-lifecycle
 * action WP support performs on a tenant's behalf.
 *
 * CANCEL IS THE ONLY STAFF LIFECYCLE ACTION, and that is deliberate: it only
 * ever STOPS sending. There is no staff `start`/`resume` counterpart and
 * there must never be one - staff must not be able to make a tenant's
 * campaign send. `lifecycle-cancel-in-tx.ts#assertUserOrStaffActor` (used by
 * cancel ONLY) is what encodes that asymmetry; every other lifecycle
 * mutation still rejects a staff actor via `assertUserActor`.
 *
 * ONE TRANSACTION, THEN BOOKKEEPING: `cancelBroadcastInTx` (the SAME body
 * the tenant route runs - never a staff-only copy) runs inside
 * `withStaffMutation`'s transaction, so the `campaigns.status='cancelled'`
 * transition, its `audit_logs` row, the tenant notification and the
 * `staff_audit_log` row all commit together. The commit is the enforcement
 * point: `claim-jobs.sql`'s campaign allow-list
 * (`cp.status IN ('running','expanding')`) fails closed the moment it lands,
 * so the next claim for this campaign's jobs returns zero rows WITHOUT any
 * job row being touched (core invariant 5 - the recipients' queued jobs are
 * disposed by the bookkeeping batch, not lost).
 *
 * The bookkeeping batch runs in `tx.afterCommit` - never inside the
 * transaction (it is a bounded multi-statement batch over the campaign's
 * recipients), and never as a precondition of the 200: a crash between the
 * commit and the bookkeeping leaves the campaign cancelled and un-claimable,
 * which is the safe direction, and the periodic
 * `runOneCancelBookkeepingSweep` picks the remainder up.
 */

export function registerInternalCampaignRoutes(
  app: FastifyInstance,
  deps: InternalRoutesDeps,
  authDeps: AuthDeps,
): void {
  registerStaffMutation(app, deps, authDeps, {
    method: 'POST',
    path: '/internal/v1/campaigns/:id/cancel',
    scope: 'internal:campaigns:cancel',
    action: 'campaigns.cancel',
    bodySchema: cancelCampaignInputSchema,
    targetKind: 'campaign',
    resolveTarget: (pathId, body) => ({ clientId: body.clientId, targetRef: pathId }),
    run: async (tx, ctx) => {
      // `cancelBroadcastInTx` itself raises `BroadcastNotFoundError` (404)
      // for a campaign that does not exist OR belongs to another client -
      // `readCampaign` is `client_id`-scoped, so a cross-tenant id is
      // indistinguishable from a missing one (core invariant 4).
      const detail = await cancelBroadcastInTx(
        tx,
        { kind: 'staff', staffId: tx.actor.staffId },
        { clientId: ctx.clientId, id: ctx.pathId },
      );

      await notify(tx, {
        clientId: ctx.clientId,
        kind: 'campaign_cancelled_by_staff',
        transitionId: String(tx.auditId),
        payload: { campaignId: ctx.pathId },
      });

      tx.afterCommit(async () => {
        // The batch's own result (counts of disposed jobs/recipients) is
        // deliberately discarded: `afterCommit` runs strictly after the
        // response's transaction has committed, so there is nothing left to
        // report it to, and a failure here is logged by `withStaffMutation`
        // rather than turned into a 5xx (the cancel has already landed and
        // is already un-claimable).
        await runCancelBookkeepingBatch(ctx.deps.tenantDb, {
          clientId: ctx.clientId,
          campaignId: ctx.pathId,
        });
      });

      return { campaignId: detail.id, status: 'cancelled' };
    },
  });
}
