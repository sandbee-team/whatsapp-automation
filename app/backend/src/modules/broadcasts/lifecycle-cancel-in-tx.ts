import type { TenantQueryable } from '@wp/db';
import type { BroadcastStatus } from '@wp/domain';
import { provisioningRepo } from '../tenancy/index.js';
import { readCampaign, transition } from './broadcasts.repo.js';
import { BroadcastNotFoundError, IllegalBroadcastTransitionError } from './broadcasts.errors.js';
import { BroadcastActorForbiddenError } from './broadcasts.errors.js';
import { toDetail, type BroadcastDetail } from './lifecycle-detail.js';
import type { BroadcastActor } from './lifecycle.service.js';

/**
 * lifecycle-cancel-in-tx.ts (P28 Unit U3b, step 5) - `cancelBroadcastInTx`,
 * the read + `transition` + `audit_logs` half of a campaign cancel, running
 * on the CALLER'S transaction handle. Split out of `lifecycle.service.ts`
 * (at exactly 300/300 lines) and called from BOTH:
 *
 *  - `lifecycle.service.ts#cancelBroadcast` - the TENANT route, which wraps
 *    this in its own `withTenant` and then runs the bookkeeping batch;
 *  - `modules/internal/routes/campaigns.ts` - the STAFF `/internal/v1`
 *    route, which runs it inside `withStaffMutation`'s transaction (so the
 *    cancel and its `staff_audit_log` row commit atomically together) and
 *    schedules the bookkeeping batch in `tx.afterCommit`.
 *
 * ONE shared body rather than two: the cancel's enforcement point is the
 * `campaigns.status = 'cancelled'` COMMIT (the claim predicate's allow-list
 * fails closed on any status outside `('running','expanding')`). A second,
 * independently-drifting copy of that transition for staff is exactly how a
 * staff cancel ends up not actually stopping claims.
 *
 * ACTOR (`assertUserOrStaffActor`, defined here and used by CANCEL ONLY):
 * every other lifecycle mutation still goes through
 * `lifecycle.service.ts#assertUserActor` and still rejects a staff actor.
 * Cancel is the single exception because it is the one lifecycle action WP
 * support legitimately performs on a tenant's behalf (a campaign that must
 * be stopped now), and it is the SAFE direction: cancel only ever STOPS
 * sending. There is deliberately no staff `start`/`resume` counterpart -
 * staff must never be able to make a tenant's campaign send.
 */

const NON_TERMINAL_STATUSES: BroadcastStatus[] = [
  'draft',
  'scheduled',
  'snapshotting',
  'expanding',
  'running',
  'paused',
];

/** The `cancel_reason` written for a staff-initiated cancel - distinct from the tenant's `'user_requested'` so the reason column alone says who stopped the campaign. */
export const STAFF_CANCEL_REASON = 'staff_cancelled';

/**
 * Fail-closed actor gate for CANCEL ONLY (see module doc): accepts a tenant
 * user (`kind:'user'` with a `userId`) or a named staff member
 * (`kind:'staff'` with a `staffId`), and rejects `api_key`/`system` - or
 * either human kind missing its own id - BEFORE any query runs.
 */
export function assertUserOrStaffActor(
  actor: BroadcastActor,
): asserts actor is { kind: 'user'; userId: string } | { kind: 'staff'; staffId: string } {
  if (actor.kind === 'user' && actor.userId && actor.userId.trim().length > 0) return;
  if (actor.kind === 'staff' && actor.staffId && actor.staffId.trim().length > 0) return;
  throw new BroadcastActorForbiddenError(actor.kind);
}

export interface CancelBroadcastInTxInput {
  clientId: string;
  id: string;
  reason?: string;
}

/** Applies the cancel transition and its `audit_logs` row on `tx` - see module doc. Never runs the bookkeeping batch (the caller owns that, after commit). */
export async function cancelBroadcastInTx(
  tx: TenantQueryable,
  actor: BroadcastActor,
  input: CancelBroadcastInTxInput,
): Promise<BroadcastDetail> {
  assertUserOrStaffActor(actor);
  const isStaff = actor.kind === 'staff';

  const existing = await readCampaign(tx, input.clientId, input.id);
  if (!existing) throw new BroadcastNotFoundError();

  const row = await transition(tx, {
    clientId: input.clientId,
    id: input.id,
    from: NON_TERMINAL_STATUSES,
    to: 'cancelled',
    set: {
      cancel_reason: input.reason ?? (isStaff ? STAFF_CANCEL_REASON : 'user_requested'),
    },
  });
  if (!row) throw new IllegalBroadcastTransitionError(input.id);

  await provisioningRepo.insertAuditLog(tx, {
    clientId: input.clientId,
    // A staff row carries `actor_staff_id` and leaves `actor_user_id` NULL,
    // so a tenant reading its own audit trail sees plainly that WP support
    // stopped this campaign, not one of its own users.
    actorType: isStaff ? 'staff' : 'user',
    actorUserId: isStaff ? null : actor.userId,
    actorStaffId: isStaff ? actor.staffId : null,
    action: 'broadcast.cancel',
    targetType: 'campaigns',
    targetId: input.id,
  });

  return toDetail(tx, input.clientId, row);
}
