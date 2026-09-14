import { extractTemplateTokens, nextCampaignState, type BroadcastStatus } from '@wp/domain';
import { provisioningRepo } from '../tenancy/index.js';
import { publishWakeForClient } from '../wallet/index.js';
import {
  createCampaign,
  findInstanceForClient,
  readCampaign,
  transition,
} from './broadcasts.repo.js';
import { runCancelBookkeepingBatch } from './cancel-bookkeeping.js';
import { toDetail, type BroadcastDetail, type LifecycleDeps } from './lifecycle-detail.js';
import { cancelBroadcastInTx } from './lifecycle-cancel-in-tx.js';
import {
  BroadcastActorForbiddenError,
  BroadcastNotFoundError,
  GroupsAudienceTemplateVarsError,
  IllegalBroadcastTransitionError,
  InstanceNotFoundError,
} from './broadcasts.errors.js';

/**
 * lifecycle.service.ts (P23 Unit U5, step 6) - the broadcast lifecycle
 * MUTATIONS: create/start/pause/resume/cancel. A human owns a broadcast's
 * lifecycle (canon): every mutation takes an explicit `actor: { kind;
 * userId? }` and `assertUserActor` rejects any non-`'user'` actor (or a
 * `'user'` with no `userId`) BEFORE any query runs - the SAME fail-closed
 * shape `modules/queue/unresolved.service.ts` uses (no second,
 * independently-drifting actor gate). The read paths (`getBroadcast`/
 * `listBroadcasts`) and the wire-shaping helper live in the `lifecycle-
 * detail.ts` sibling (300-line cap split).
 *
 * `completed` is NEVER written here - the funnel recompute (P23a) is the
 * only writer of that terminal state, once no recipient remains
 * non-terminal.
 */

export type { LifecycleDeps, BroadcastDetail } from './lifecycle-detail.js';
export { getBroadcast, listBroadcasts } from './lifecycle-reads.js';

/** `'staff'` (P28 U3b) is accepted by CANCEL ONLY - see `lifecycle-cancel-in-tx.ts`'s own header for why there is no staff start/resume counterpart. */
export type BroadcastActorKind = 'user' | 'api_key' | 'system' | 'staff';
export interface BroadcastActor {
  kind: BroadcastActorKind;
  userId?: string;
  /** Set only for `kind: 'staff'` - the acting `staff_users.id`. */
  staffId?: string;
}

/** Fail-closed actor gate - throws BEFORE any query runs. Mirrors `unresolved.service.ts#assertUserActor` exactly. */
export function assertUserActor(
  actor: BroadcastActor,
): asserts actor is { kind: 'user'; userId: string } {
  if (actor.kind !== 'user' || !actor.userId || actor.userId.trim().length === 0) {
    throw new BroadcastActorForbiddenError(actor.kind);
  }
}

export interface CreateBroadcastServiceInput {
  clientId: string;
  actor: BroadcastActor;
  idempotencyKey: string;
  name: string;
  instanceId: string;
  audience: Record<string, unknown>;
  message: Record<string, unknown>;
  priority: 'high' | 'normal' | 'low';
  scheduledAt: string | null;
}

export async function createBroadcast(
  deps: LifecycleDeps,
  input: CreateBroadcastServiceInput,
): Promise<BroadcastDetail> {
  assertUserActor(input.actor);
  // Narrowing from `assertUserActor` does not cross the closure boundary
  // below (TS control-flow narrowing is scoped to this function, not the
  // async callback passed to `withTenant`) - capture the now-definite
  // `userId` in a local so the closure reads a `string`, not `input.actor.
  // userId` (which reverts to `string | undefined` inside the callback).
  const actorUserId = input.actor.userId;

  // `target_kind` is ALWAYS derived from `audience.kind` server-side (P24
  // Unit U6); a `groups` message may not carry a `{{token}}` - rejected here,
  // before any row is written (no per-recipient record to freeze against).
  const audienceKind = (input.audience as { kind?: unknown }).kind;
  const targetKind: 'contacts' | 'groups' = audienceKind === 'groups' ? 'groups' : 'contacts';
  if (targetKind === 'groups') {
    const body = (input.message as { body?: unknown }).body;
    if (typeof body === 'string' && extractTemplateTokens(body).length > 0) {
      throw new GroupsAudienceTemplateVarsError();
    }
  }

  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const instance = await findInstanceForClient(tx, input.clientId, input.instanceId);
    if (!instance) {
      throw new InstanceNotFoundError();
    }

    const { id, created } = await createCampaign(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      createdByUserId: actorUserId,
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      audience: input.audience,
      message: input.message,
      targetKind,
      priority: input.priority,
      scheduledAt: input.scheduledAt,
    });

    if (created) {
      await provisioningRepo.insertAuditLog(tx, {
        clientId: input.clientId,
        actorType: 'user',
        actorUserId: actorUserId,
        action: 'broadcast.create',
        targetType: 'campaigns',
        targetId: id,
        metadata: { instanceId: input.instanceId },
      });
    }

    const row = await readCampaign(tx, input.clientId, id);
    if (!row) throw new BroadcastNotFoundError();
    return toDetail(tx, input.clientId, row);
  });
}

async function mutateOne(
  deps: LifecycleDeps,
  clientId: string,
  id: string,
  from: BroadcastStatus | BroadcastStatus[],
  to: BroadcastStatus,
  action: string,
  actor: { kind: 'user'; userId: string },
  set?: Record<string, unknown>,
): Promise<BroadcastDetail> {
  return deps.tenantDb.withTenant(clientId, async (tx) => {
    const existing = await readCampaign(tx, clientId, id);
    if (!existing) throw new BroadcastNotFoundError();

    const row = await transition(tx, { clientId, id, from, to, set });
    if (!row) throw new IllegalBroadcastTransitionError(id);

    await provisioningRepo.insertAuditLog(tx, {
      clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action,
      targetType: 'campaigns',
      targetId: id,
    });

    return toDetail(tx, clientId, row);
  });
}

export async function startBroadcast(
  deps: LifecycleDeps,
  actor: BroadcastActor,
  input: { clientId: string; id: string },
): Promise<BroadcastDetail> {
  assertUserActor(actor);
  return mutateOne(
    deps,
    input.clientId,
    input.id,
    ['draft', 'scheduled'],
    'snapshotting',
    'broadcast.start',
    actor,
  );
}

/** Queued jobs are NOT touched (invariant 5) - the claim predicate stops them at the very next claim. */
export async function pauseBroadcast(
  deps: LifecycleDeps,
  actor: BroadcastActor,
  input: { clientId: string; id: string },
): Promise<BroadcastDetail> {
  assertUserActor(actor);
  return mutateOne(
    deps,
    input.clientId,
    input.id,
    ['running', 'expanding'],
    'paused',
    'broadcast.pause',
    actor,
    { paused_by_user_id: actor.userId },
  );
}

/**
 * `resume` needs `ctx.expansionComplete` (whether Phase B had already
 * finished before the pause) - read from `expand_done_at IS NOT NULL` before
 * calling `nextCampaignState`. `publishWakeForClient` runs strictly AFTER
 * the transition transaction has committed, outside of it (P19's publisher,
 * never a second one).
 */
export async function resumeBroadcast(
  deps: LifecycleDeps,
  actor: BroadcastActor,
  input: { clientId: string; id: string },
): Promise<BroadcastDetail> {
  assertUserActor(actor);

  const detail = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const existing = await readCampaign(tx, input.clientId, input.id);
    if (!existing) throw new BroadcastNotFoundError();

    const to = nextCampaignState('paused', 'resume', {
      expansionComplete: existing.expand_done_at !== null,
    });

    const row = await transition(tx, {
      clientId: input.clientId,
      id: input.id,
      from: 'paused',
      to,
    });
    if (!row) throw new IllegalBroadcastTransitionError(input.id);

    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'broadcast.resume',
      targetType: 'campaigns',
      targetId: input.id,
    });

    return toDetail(tx, input.clientId, row);
  });

  // Strictly AFTER the transition transaction above has already committed
  // (this is a NEW, separate transaction) - same idiom as
  // `credit.service.ts#creditWalletAndNotify`.
  await deps.tenantDb.withTenant(input.clientId, (tx) =>
    publishWakeForClient({ db: tx, publishWake: deps.publishWake }, input.clientId),
  );

  return detail;
}

/**
 * `campaigns.status = 'cancelled'` commits in ONE small transaction - THAT
 * COMMIT is the enforcement point (the claim predicate's allow-list already
 * fails closed on any status outside `('running','expanding')`). The
 * bookkeeping batch runs AFTER, outside this transaction - a crash between
 * the commit and the bookkeeping never re-opens the campaign to new claims.
 *
 * The transition/audit body itself lives in `lifecycle-cancel-in-tx.ts#
 * cancelBroadcastInTx`, shared verbatim with the staff `/internal/v1`
 * cancel route (see that module's own header) - one body, so a staff cancel
 * and a tenant cancel can never drift into stopping claims differently.
 */
export async function cancelBroadcast(
  deps: LifecycleDeps,
  actor: BroadcastActor,
  input: { clientId: string; id: string; reason?: string },
): Promise<BroadcastDetail> {
  // The TENANT entry point stays strictly user-only, unchanged: the shared
  // body accepts a staff actor too (for the `/internal/v1` route), so
  // without this line a `kind:'staff'` actor smuggled through a tenant
  // session would suddenly be accepted here. Only the staff route may pass
  // a staff actor, and it calls `cancelBroadcastInTx` directly.
  assertUserActor(actor);

  const detail = await deps.tenantDb.withTenant(input.clientId, (tx) =>
    cancelBroadcastInTx(tx, actor, input),
  );

  const runBookkeeping =
    deps.runBookkeeping ??
    ((bkInput: { clientId: string; campaignId: string }) =>
      runCancelBookkeepingBatch(deps.tenantDb, bkInput));
  await runBookkeeping({ clientId: input.clientId, campaignId: input.id });

  return detail;
}
