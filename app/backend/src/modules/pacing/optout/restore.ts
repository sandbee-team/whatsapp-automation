import type { TenantQueryable } from '@wp/db';
import type { OptOutMirrorPort } from './registry.js';

/**
 * restore.ts (P14 Unit U3, step 5; MINOR 11 FIX, P14 review-fix F2; P20 Unit
 * U8, step 8 - the injected mirror port) - `restoreOptOut`, the ONLY path
 * back from a durable `opt_outs` row (deletion is impossible by design - no
 * DELETE grant exists on that table for any app role, migration 0036).
 * Human-only (ADR 0015 decision 4): there is NO api-key and NO system path to
 * restore, ever - an automated/API-triggered restore would be exactly the
 * kind of compliance-weakening surface core invariant 6 forbids, since a
 * bulk/scripted restore could silently re-enable sends to everyone who ever
 * opted out. `actor.type !== 'user'` (or a `'user'` actor missing its
 * `userId`) is rejected with `ForbiddenRestoreActorError` before any query
 * runs.
 *
 * `deps.mirror` (same `OptOutMirrorPort` `registry.ts#recordOptOut` takes)
 * runs INSIDE the same `tx`, AFTER the audit INSERT - never for the
 * not-found/already-restored path above, which throws before either write.
 */
export class ForbiddenRestoreActorError extends Error {
  readonly code = 'FORBIDDEN';
  readonly details: Record<string, unknown>;
  constructor(reason: string) {
    super('Opt-out restoration requires a human user actor.');
    this.name = 'ForbiddenRestoreActorError';
    this.details = { reason };
  }
}

/**
 * Thrown when the restore UPDATE matches zero rows (no such `opt_outs` row
 * for this `clientId`, or it was already restored) - MINOR 11 FIX (P14
 * review-fix F2): the audit INSERT must never run for a restore that did
 * not actually happen; a not-found/already-restored attempt is a genuine
 * error the caller must surface, not a silent no-op audit entry.
 */
export class OptOutNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly details: Record<string, unknown>;
  constructor(optOutId: string, clientId: string) {
    super(`restoreOptOut: no unrestored opt_outs row ${optOutId} for client ${clientId}`);
    this.name = 'OptOutNotFoundError';
    this.details = { optOutId, clientId };
  }
}

export type RestoreActor = { type: 'user' | 'api_key' | 'system'; userId?: string };

export interface RestoreOptOutInput {
  clientId: string;
  optOutId: string;
  actor: RestoreActor;
  restoreReason: string;
}

/** Throws unless `actor` is a human user carrying a `userId` - see module doc. */
function assertHumanActor(actor: RestoreActor): asserts actor is { type: 'user'; userId: string } {
  if (actor.type !== 'user') {
    throw new ForbiddenRestoreActorError(`actor.type "${actor.type}" is not a human user`);
  }
  if (!actor.userId) {
    throw new ForbiddenRestoreActorError('a user actor must carry a userId');
  }
}

/** Throws (a plain `Error`, not `ForbiddenRestoreActorError` - this is a validation failure, not an authorization one) unless `reason` is a non-empty, trimmed string. */
function assertTypedReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new Error('restoreOptOut: restoreReason must be a non-empty, typed reason');
  }
  return trimmed;
}

/**
 * Restores `optOutId` (UPDATE `restored_at`/`restored_by`/`restore_reason`,
 * scoped to `clientId` and only when currently unrestored) and writes one
 * `audit_logs` row in the SAME transaction - same `insertAuditLog` shape as
 * `modules/tenancy/provisioning.repo.ts` (its `'reason'` metadata key is
 * already on `ALLOWED_AUDIT_METADATA_KEYS`), inlined here rather than
 * imported to avoid a cross-module dependency edge from `modules/pacing` onto
 * `modules/tenancy` for one INSERT shape.
 */
export async function restoreOptOut(
  tx: TenantQueryable,
  input: RestoreOptOutInput,
  deps: { mirror: OptOutMirrorPort },
): Promise<void> {
  assertHumanActor(input.actor);
  const reason = assertTypedReason(input.restoreReason);

  const updateResult = await tx.query<{ phone_hash: Buffer }>(
    `UPDATE opt_outs SET restored_at = now(), restored_by = $3, restore_reason = $4
      WHERE id = $1 AND client_id = $2 AND restored_at IS NULL
      RETURNING phone_hash`,
    [input.optOutId, input.clientId, input.actor.userId, reason],
  );
  // MINOR 11 FIX (P14 review-fix F2): zero rows means no such opt_outs row
  // for this client, or it was already restored - the audit INSERT below
  // must never run for a restore that did not actually happen.
  const restoredRow = updateResult.rows[0];
  if (updateResult.rowCount !== 1 || !restoredRow) {
    throw new OptOutNotFoundError(input.optOutId, input.clientId);
  }

  await tx.query(
    `INSERT INTO audit_logs (client_id, actor_type, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.clientId,
      'user',
      input.actor.userId,
      'optout.restore',
      'opt_out',
      input.optOutId,
      JSON.stringify({ reason }),
    ],
  );

  await deps.mirror(tx, { clientId: input.clientId, phoneHash: restoredRow.phone_hash });
}
