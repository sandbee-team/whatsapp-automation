import type { TenantQueryable } from '@wp/db';

/**
 * dirty-set.ts (P16 Unit E, step 9) - the ONE write point that forces an
 * instance back onto tier 1 (60s cadence) of the health evaluator's due-scan
 * ladder. Called from the fast-lane entry points (`fast-lane.ts#onSendOutcome`
 * / `#onConnectionUpdate`) and the send-outcome/connection-update composition
 * seams - never from the evaluator tick itself (the tick sets its OWN next
 * `eval_due_at`/`eval_tier` via `HealthEvaluator.ts#writeBookkeeping`'s tier
 * ladder, unconditionally, at the end of every tick - see that module's doc).
 *
 * Unconditional, idempotent-by-construction (core invariant 3): re-marking an
 * already-dirty (tier 1, already-due) instance is a harmless no-op write, not
 * a special-cased skip - the next due-scan picks it up exactly once regardless
 * of how many times `markDirty` fired in between.
 */
export interface MarkDirtyInput {
  clientId: string;
  instanceId: string;
}

export async function markDirty(sql: TenantQueryable, input: MarkDirtyInput): Promise<void> {
  await sql.query(
    `UPDATE instance_pacing_state SET
        eval_due_at = now(),
        eval_tier = 1,
        updated_at = now()
      WHERE instance_id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId],
  );
}
