import type { TenantDb, TenantQueryable } from '@wp/db';
import { provisioningRepo } from '../tenancy/index.js';
import { BroadcastActorForbiddenError, BroadcastNotFoundError } from './broadcasts.errors.js';

/**
 * restamp.service.ts (P23 Unit U6, step 7) - the ONLY human-confirmed exit
 * out of the review-hold state for a `session_epoch_advanced` job, mirror
 * of `modules/queue/unresolved.service.ts`'s exact actor-gate/replay
 * discipline (`scripts/check-no-auto-requeue.ts`'s `NO_AUTO_REQUEUE_EXEMPT_
 * PATHS` names this file explicitly - its transition query must always stay
 * lexically nested inside a function whose own parameter list names a
 * top-level `actor`, exactly as `restampBroadcast` below does).
 *
 * `assertRestampUserActor` throws BEFORE any query runs for any non-`user`
 * actor (core invariant 2: no automatic path - no cron, worker or flag may
 * ever reach the re-stamp write). `confirmCount` must equal the LIVE review-
 * hold count for this number (instance) or NOTHING is re-stamped (409
 * `RESTAMP_COUNT_MISMATCH`, carrying `{ expected }`) - a typed confirmation
 * naming the same number the phase canon requires, never a blind "re-stamp
 * everything". The alternative for the tenant is the existing cancel route
 * (U5) - this module builds no second cancel path.
 *
 * The restamp is deliberately INSTANCE-scoped, not campaign-scoped: epoch
 * stranding happens to a whatsapp_instances row (a re-linked number), and
 * every OTHER campaign queued on that same instance is just as stranded -
 * restamping only the requesting campaign's jobs would leave sibling
 * campaigns' jobs stuck in review-hold forever. `input.campaignId` is used
 * only to resolve WHICH instance the caller means; the count and the UPDATE
 * both share the instance-scoped predicate below.
 *
 * Batches of 500, each its own transaction (same resumability shape as
 * `epoch-sweep.ts`'s own sweep): the job's epoch column is set to the
 * instance's current value, its lifecycle column returns to the sendable
 * state, and its review-hold markers are all cleared. One audit row
 * (targeting the instance, `metadata: { count }`) after the LAST batch
 * commits, then ONE `publishWakeForClient` call per instance of the client,
 * outside every transaction (mirrors `resume-wake.ts`'s own "after commit,
 * never inside" contract).
 */

export type RestampActorKind = 'user' | 'api_key' | 'system';

export interface RestampActor {
  kind: RestampActorKind;
  userId?: string;
}

/** Fail-closed actor gate - throws BEFORE any query runs. Same shape as `unresolved.service.ts#assertUserActor`. */
export function assertRestampUserActor(
  actor: RestampActor,
): asserts actor is { kind: 'user'; userId: string } {
  if (actor.kind !== 'user' || !actor.userId || actor.userId.trim().length === 0) {
    throw new BroadcastActorForbiddenError(actor.kind);
  }
}

export class RestampCountMismatchError extends Error {
  readonly code = 'RESTAMP_COUNT_MISMATCH';
  readonly details: { expected: number };
  constructor(expected: number) {
    super(
      `confirmCount does not match the live count of stranded jobs for this number (instance) (expected ${String(expected)}); nothing was re-stamped.`,
    );
    this.name = 'RestampCountMismatchError';
    this.details = { expected };
  }
}

export interface RestampBroadcastInput {
  clientId: string;
  campaignId: string;
  confirmCount: number;
  idempotencyKey: string;
}

export interface RestampBroadcastResult {
  restamped: number;
  sessionEpoch: number;
}

export interface RestampBroadcastDeps {
  tenantDb: TenantDb;
  /** Optional so a caller supplying only `{ tenantDb }` still compiles (roles/api.ts binds the real publisher); omitted means the next natural poll/backoff wakes the instance instead - never a correctness gap, only latency. */
  publishWakeForClient?: (clientId: string) => Promise<void>;
}

const BATCH_SIZE = 500;

interface CampaignInstanceRow extends Record<string, unknown> {
  instance_id: string;
}

interface InstanceEpochRow extends Record<string, unknown> {
  session_epoch: number;
}

async function readCampaignInstance(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<string | undefined> {
  const result = await tx.query<CampaignInstanceRow>(
    `SELECT instance_id FROM campaigns WHERE id = $1 AND client_id = $2
      -- client_id = $2`,
    [campaignId, clientId],
  );
  return result.rows[0]?.instance_id;
}

async function readCurrentEpoch(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number | undefined> {
  const result = await tx.query<InstanceEpochRow>(
    `SELECT session_epoch FROM whatsapp_instances
      WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL
      -- client_id = $2`,
    [instanceId, clientId],
  );
  return result.rows[0]?.session_epoch;
}

async function countStrandedForCampaign(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const result = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_jobs
      WHERE client_id = $1 AND instance_id = $2 AND status = 'blocked_needs_review'
        AND unresolved_reason = 'session_epoch_advanced'
      -- client_id = $1`,
    [clientId, instanceId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Restamps every `blocked_needs_review`/`session_epoch_advanced` job of
 * `input.campaignId`'s instance (i.e. every stranded job of that NUMBER, not
 * just this campaign's own) to the instance's CURRENT `session_epoch`, but
 * ONLY when `input.confirmCount` matches the live count exactly. Throws
 * `BroadcastActorForbiddenError` (non-user actor), `BroadcastNotFoundError`
 * (no such campaign for this tenant), or `RestampCountMismatchError` (count
 * mismatch - nothing written) before any re-stamp write runs.
 */
export async function restampBroadcast(
  deps: RestampBroadcastDeps,
  actor: RestampActor,
  input: RestampBroadcastInput,
): Promise<RestampBroadcastResult> {
  assertRestampUserActor(actor);

  const { instanceId, currentEpoch } = await deps.tenantDb.withTenant(
    input.clientId,
    async (tx) => {
      const foundInstanceId = await readCampaignInstance(tx, input.clientId, input.campaignId);
      if (foundInstanceId === undefined) {
        throw new BroadcastNotFoundError();
      }
      const epoch = await readCurrentEpoch(tx, input.clientId, foundInstanceId);
      if (epoch === undefined) {
        throw new BroadcastNotFoundError();
      }
      const liveCount = await countStrandedForCampaign(tx, input.clientId, foundInstanceId);
      if (liveCount !== input.confirmCount) {
        throw new RestampCountMismatchError(liveCount);
      }
      return { instanceId: foundInstanceId, currentEpoch: epoch };
    },
  );

  let restamped = 0;
  for (;;) {
    // The actual restamp UPDATE lives INSIDE this closure so the no-auto-
    // requeue guard's actor-enclosure check finds `actor` in an enclosing
    // parameter list (this file's own module-header contract) - never
    // delegated to a separate top-level helper function.
    const batchRestamped = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE message_jobs j SET session_epoch = $3,
            status = 'queued',
            needs_user_action = false,
            unresolved_reason = NULL,
            unresolved_at = NULL,
            next_attempt_at = now(),
            updated_at = now()
       FROM (
         SELECT id, created_at FROM message_jobs
          WHERE client_id = $1 AND instance_id = $2 AND status = 'blocked_needs_review'
            AND unresolved_reason = 'session_epoch_advanced'
          ORDER BY id
          LIMIT $4
          FOR UPDATE SKIP LOCKED
       ) s
      WHERE j.id = s.id AND j.created_at = s.created_at AND j.status = 'blocked_needs_review'
        AND j.unresolved_reason = 'session_epoch_advanced'
      -- client_id = $1
     RETURNING j.id`,
        [input.clientId, instanceId, currentEpoch, BATCH_SIZE],
      );
      return result.rowCount ?? 0;
    });
    restamped += batchRestamped;
    if (batchRestamped < BATCH_SIZE) {
      break;
    }
  }

  await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    await provisioningRepo.insertAuditLog(tx, {
      clientId: input.clientId,
      actorType: 'user',
      actorUserId: actor.userId,
      action: 'message.broadcast_restamped',
      // Instance-scoped, matching the UPDATE's own predicate above (see
      // this file's doc comment): the affected set is every stranded job of
      // this NUMBER, not just input.campaignId's own jobs.
      targetType: 'whatsapp_instances',
      targetId: instanceId,
      metadata: { count: restamped },
    });
  });

  await deps.publishWakeForClient?.(input.clientId);

  return { restamped, sessionEpoch: currentEpoch };
}
