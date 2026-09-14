import type { TenantDb, TenantQueryable } from '@wp/db';
import { deliveryEventId, writeDeliveryEvent } from '../../engine/queue/delivery-event.js';
import { provisioningRepo } from '../tenancy/index.js';
import type { RepairedSendSink } from './repaired-send-sink.js';
import {
  lookupUnresolvedJob,
  recordActionKeyOrReplay,
  UnresolvedJobLookupMissError,
} from './unresolved-repo.js';

/**
 * unresolved.service.ts (P12 Unit U5, step 8) - the human two-choice path
 * out of `blocked_needs_review`: `retryUnresolved` / `discardUnresolved`.
 * THIS is the one place in the whole system allowed to move a job out of
 * `blocked_needs_review` (core invariant 2, fail-safe: no automatic
 * requeue anywhere - `scripts/check-no-auto-requeue.ts` enforces that
 * mechanically). Both actions are per-tenant (`tenantDb.withTenant`,
 * invariant 4), both are audited, and neither ever deletes or `fail`s the
 * row (invariant 5: pause/cancel preserves work). DB-facing helpers (job
 * lookup, replay guard) live in the `unresolved-repo.ts` sibling (max-lines
 * split, same idiom as `session-worker-discovery-wiring.ts`).
 *
 * ACTOR MODEL (session-open correction, binding - overrides the phase
 * file's `ctx.actor` wording): `ctx.actor` does not exist anywhere in this
 * repo. The only per-request identity is `req.auth` (`AuthenticatedContext`,
 * `platform/http/route-policy.ts`), which `authenticateRequest` populates
 * ONLY from a valid `Authorization: Bearer <JWT>` - there is no HTTP path
 * that ever produces an `api_key` or `system` actor today (no API-key auth
 * exists yet; the queue/reaper/reconciler paths never call this service).
 * So this service takes an EXPLICIT `actor: { kind; userId? }` parameter
 * instead of deriving one from a fixed `ctx.actor` shape that has no real
 * caller: `unresolved.routes.ts` always constructs `{ kind: 'user', userId:
 * req.auth.userId }`. Any other `kind`, or `'user'` with a missing/blank
 * `userId`, throws `UnresolvedActorForbiddenError` (403) BEFORE any query
 * runs - fail closed. A future phase that introduces API-key
 * authentication (not yet scheduled - no phase file references it as of
 * P12) MUST wire its own actor kind through this SAME gate, never bypass
 * it with a second code path.
 */

export type UnresolvedActorKind = 'user' | 'api_key' | 'system';

export interface UnresolvedActor {
  kind: UnresolvedActorKind;
  userId?: string;
}

export class UnresolvedActorForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(kind: UnresolvedActorKind) {
    super(
      kind === 'user'
        ? 'A user actor with a userId is required for this action.'
        : `Actor kind "${kind}" may not retry or discard an unresolved message - a human user action is required.`,
    );
    this.name = 'UnresolvedActorForbiddenError';
  }
}

export class UnresolvedJobNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('No such unresolved message.');
    this.name = 'UnresolvedJobNotFoundError';
  }
}

/** Fail-closed actor gate - throws BEFORE any query runs. Exported so both actions share exactly one check. */
export function assertUserActor(
  actor: UnresolvedActor,
): asserts actor is { kind: 'user'; userId: string } {
  if (actor.kind !== 'user' || !actor.userId || actor.userId.trim().length === 0) {
    throw new UnresolvedActorForbiddenError(actor.kind);
  }
}

export interface UnresolvedActionDeps {
  tenantDb: TenantDb;
  sink: Pick<RepairedSendSink, 'onReconciledLost'>;
  /** ADR 0038 S5: the PRIMARY refund, run in-transaction (see `retryUnresolved`'s own doc). Optional so `discardUnresolved` callers need not supply it. */
  refundSend?: (
    tx: TenantQueryable,
    input: { clientId: string; attemptId: string },
  ) => Promise<unknown>;
}

export interface UnresolvedActionInput {
  clientId: string;
  jobPublicId: string;
  idempotencyKey: string;
}

export interface RetryUnresolvedResult {
  publicId: string;
  status: 'queued';
}

/**
 * Retry -> job `status='queued'`, `next_attempt_at=now()`, the attempt
 * `reconciled_lost`, one audit row carrying `actor_user_id`. Clears
 * `needs_user_action`/`unresolved_reason`/`unresolved_at`. This is the ONLY
 * function that may perform this transition (`scripts/
 * check-no-auto-requeue.ts`, exempt path) - `actor` is a genuine top-level
 * parameter so that guard's "takes an actor" check has a literal name.
 *
 * ADR 0038 S5: `deps.refundSend` runs INSIDE the SAME transaction as the
 * `reconciled_lost` UPDATE, immediately after it and before the job UPDATE -
 * the PRIMARY refund, so a crash cannot leave a lost send un-refunded.
 * `deps.sink.onReconciledLost` still runs post-commit, unconditionally - the
 * IDEMPOTENT FALLBACK (refund-send.sql's guard makes a second call a no-op).
 */
export async function retryUnresolved(
  deps: UnresolvedActionDeps,
  actor: UnresolvedActor,
  input: UnresolvedActionInput,
): Promise<RetryUnresolvedResult> {
  assertUserActor(actor);

  let reconciledLostAttemptId: string | null = null;

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    let job;
    try {
      job = await lookupUnresolvedJob(tx, input.clientId, input.jobPublicId);
    } catch (err) {
      if (err instanceof UnresolvedJobLookupMissError) throw new UnresolvedJobNotFoundError();
      throw err;
    }

    const { replay } = await recordActionKeyOrReplay(tx, {
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      messageJobId: job.message_job_id,
      messageJobCreatedAt: job.message_job_created_at,
      action: 'retry',
      actorUserId: actor.userId,
    });
    if (replay) {
      return;
    }

    // The most recent in-flight attempt (dispatched, unresolved) becomes
    // reconciled_lost - the mirror of the reconciler's own "no evidence"
    // branch (reconciler.ts#applyExpired), but human-triggered here instead
    // of window-driven.
    const attempt = await tx.query<{ id: string }>(
      `UPDATE send_attempts SET state = 'reconciled_lost', resolved_at = now()
        WHERE client_id = $1 AND message_job_id = $2
          AND id = (SELECT id FROM send_attempts
                      WHERE client_id = $1 AND message_job_id = $2 AND state = 'dispatched'
                      ORDER BY attempt_no DESC LIMIT 1)
        RETURNING id
        -- client_id = $1`,
      [input.clientId, job.message_job_id],
    );
    reconciledLostAttemptId = attempt.rows[0]?.id ?? null;

    if (reconciledLostAttemptId) {
      await deps.refundSend?.(tx, { clientId: input.clientId, attemptId: reconciledLostAttemptId });
    }

    const jobUpdate = await tx.query(
      `UPDATE message_jobs SET status = 'queued', next_attempt_at = now(),
              needs_user_action = false, unresolved_reason = NULL, unresolved_at = NULL
        WHERE id = $1 AND client_id = $2 AND status = 'blocked_needs_review'
        -- client_id = $2`,
      [job.message_job_id, input.clientId],
    );
    if (jobUpdate.rowCount === 0) {
      throw new UnresolvedJobNotFoundError();
    }

    await writeDeliveryEvent(tx, {
      clientId: input.clientId,
      instanceId: job.instance_id,
      messageJobId: job.message_job_id,
      messageJobCreatedAt: job.message_job_created_at,
      eventType: 'queued',
      providerEventId: deliveryEventId(job.instance_id, input.jobPublicId, 'queued', 0),
    });

    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'message.unresolved_retried',
      targetType: 'message_job',
      targetId: input.jobPublicId,
      metadata: { reason: 'unresolved_retry' },
    });
  });

  if (reconciledLostAttemptId) {
    await deps.sink.onReconciledLost(reconciledLostAttemptId, input.clientId);
  }

  return { publicId: input.jobPublicId, status: 'queued' };
}

export interface DiscardUnresolvedResult {
  publicId: string;
  status: 'cancelled';
}

/**
 * Discard -> job `status='cancelled'`, `cancel_reason='unresolved_
 * discarded'`, audit row. The row is NEVER deleted and NEVER `failed`
 * (invariant 5) - it stays present, visible, and queryable. No refund (ADR
 * 0019: no debit happened for an unresolved job, so there is nothing to
 * refund - the audit row records the human's choice). `actor` is a genuine
 * top-level parameter for the same reason `retryUnresolved` documents.
 */
export async function discardUnresolved(
  deps: Pick<UnresolvedActionDeps, 'tenantDb'>,
  actor: UnresolvedActor,
  input: UnresolvedActionInput,
): Promise<DiscardUnresolvedResult> {
  assertUserActor(actor);

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    let job;
    try {
      job = await lookupUnresolvedJob(tx, input.clientId, input.jobPublicId);
    } catch (err) {
      if (err instanceof UnresolvedJobLookupMissError) throw new UnresolvedJobNotFoundError();
      throw err;
    }

    const { replay } = await recordActionKeyOrReplay(tx, {
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      messageJobId: job.message_job_id,
      messageJobCreatedAt: job.message_job_created_at,
      action: 'discard',
      actorUserId: actor.userId,
    });
    if (replay) {
      return;
    }

    const jobUpdate = await tx.query(
      `UPDATE message_jobs SET status = 'cancelled', cancel_reason = 'unresolved_discarded', terminal_at = now(),
              needs_user_action = false, unresolved_reason = NULL, unresolved_at = NULL
        WHERE id = $1 AND client_id = $2 AND status = 'blocked_needs_review'
        -- client_id = $2`,
      [job.message_job_id, input.clientId],
    );
    if (jobUpdate.rowCount === 0) {
      throw new UnresolvedJobNotFoundError();
    }

    await writeDeliveryEvent(tx, {
      clientId: input.clientId,
      instanceId: job.instance_id,
      messageJobId: job.message_job_id,
      messageJobCreatedAt: job.message_job_created_at,
      eventType: 'cancelled',
      providerEventId: deliveryEventId(job.instance_id, input.jobPublicId, 'cancelled', 0),
    });

    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'message.unresolved_discarded',
      targetType: 'message_job',
      targetId: input.jobPublicId,
      metadata: { reason: 'unresolved_discarded' },
    });
  });

  return { publicId: input.jobPublicId, status: 'cancelled' };
}
