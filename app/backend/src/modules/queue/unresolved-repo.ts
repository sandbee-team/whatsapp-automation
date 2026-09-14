import type { TenantQueryable } from '@wp/db';

/**
 * unresolved-repo.ts (P12 Unit U5) - the DB-facing half of
 * `unresolved.service.ts`, split out at the max-lines cap (same split idiom
 * as `session-worker-discovery-wiring.ts`). Owns the job lookup and the
 * `unresolved_action_keys` replay guard; the service module owns the actor
 * gate, the two state transitions, and orchestration.
 */

export interface UnresolvedJobRow extends Record<string, unknown> {
  message_job_id: string;
  message_job_created_at: Date;
  instance_id: string;
  status: string;
}

interface ExistingActionRow extends Record<string, unknown> {
  action: string;
  inserted: boolean;
}

/** Thrown when `jobPublicId` has no matching `message_job_refs`/`message_jobs` row for this tenant. */
export class UnresolvedJobLookupMissError extends Error {}

export async function lookupUnresolvedJob(
  tx: TenantQueryable,
  clientId: string,
  jobPublicId: string,
): Promise<UnresolvedJobRow> {
  const result = await tx.query<UnresolvedJobRow>(
    `SELECT j.id AS message_job_id, j.created_at AS message_job_created_at,
            j.instance_id, j.status
       FROM message_job_refs r
       JOIN message_jobs j ON j.id = r.message_job_id AND j.client_id = r.client_id
      WHERE r.client_id = $1 AND r.public_id = $2
      -- client_id = $1`,
    [clientId, jobPublicId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new UnresolvedJobLookupMissError();
  }
  return row;
}

/**
 * Replay guard: inserts the idempotency key FIRST (the `unresolved_action_
 * keys` PK is the replay authority - migration 0026). A conflict means this
 * exact `(client_id, idempotency_key)` pair already recorded an action;
 * returns `{ replay: true }` so the caller can short-circuit to a no-op
 * response WITHOUT re-running the state transition, mirroring
 * `messages.repo.ts`'s no-op `DO UPDATE ... RETURNING` idiom (never `DO
 * NOTHING` - the loser must still get a row back, not a 5xx).
 */
export async function recordActionKeyOrReplay(
  tx: TenantQueryable,
  input: {
    clientId: string;
    idempotencyKey: string;
    messageJobId: string;
    messageJobCreatedAt: Date;
    action: 'retry' | 'discard';
    actorUserId: string;
  },
): Promise<{ replay: boolean }> {
  const result = await tx.query<ExistingActionRow>(
    `INSERT INTO unresolved_action_keys
       (client_id, idempotency_key, message_job_id, message_job_created_at, action, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (client_id, idempotency_key)
     DO UPDATE SET action = unresolved_action_keys.action
     RETURNING action, (xmax = 0) AS inserted
     -- client_id = $1`,
    [
      input.clientId,
      input.idempotencyKey,
      input.messageJobId,
      input.messageJobCreatedAt,
      input.action,
      input.actorUserId,
    ],
  );
  const row = result.rows[0];
  // `xmax = 0` is Postgres's own tell for "this row version was created by
  // THIS statement's INSERT branch, never touched by the UPDATE branch" -
  // the standard idiom for distinguishing a fresh insert from an
  // ON-CONFLICT-DO-UPDATE no-op inside one RETURNING clause (there is no
  // other way to tell them apart from the returned row's columns alone,
  // since the no-op DO UPDATE writes back the SAME action value either
  // way). `row.action !== input.action` on the replay branch would mean a
  // key reused with a DIFFERENT action - a caller bug, not a routine
  // replay - callers here never issue retry/discard on the same key for two
  // different actions, so this is intentionally not distinguished further
  // (a real key-reuse-with-different-action detector would mirror
  // messages.service.ts's request_hash comparison, out of this unit's
  // scope: unresolved_action_keys carries no request hash).
  return { replay: row !== undefined && !row.inserted };
}
