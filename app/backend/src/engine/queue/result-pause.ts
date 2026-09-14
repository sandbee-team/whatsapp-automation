import type { TenantQueryable } from '@wp/db';
import type { PauseReason } from '@wp/domain';

/**
 * result-pause.ts (P11 Unit U4, step 7) - the PAUSE_INSTANCE outcome's
 * `whatsapp_instances` write, split out of `result.ts` for readability (not
 * a max-lines-cap split - result.ts has headroom - but pausing is a
 * conceptually distinct write from the job-outcome update it sits beside).
 *
 * NON-fence-guarded, client_id-scoped only - mirrors
 * `instance-mark-infra-unavailable.sql`'s precedent (P09 Unit U3): the
 * queue/send-path worker that runs `result.ts` is not the actor holding
 * this instance's session lease/fence (that is the session-worker role's
 * own concern, `engine/session/**`), so this write cannot carry that
 * predicate family the way `modules/instances/repo.ts`'s ENGINE writes do.
 * Idempotent + conditional (core invariant 3): the WHERE clause only
 * matches a row not ALREADY paused for this exact reason - a repeat call
 * (e.g. two send failures racing to pause the same instance) is a zero-row
 * no-op, never a second write. Migration 0025 grants wp_scheduler
 * `UPDATE (health_state, pause_reason, paused_at, needs_user_action)` on
 * this table for exactly this statement.
 */

export type PauseReasonInput = PauseReason;

/**
 * `classify()`-category -> `PauseReason` mapping. Lives HERE, not in
 * `result.ts` (P12 C1 review, finding 2 fallout): `reaper-failure-
 * reclassify.ts`'s failure re-drive needs this same table, and it must
 * import it WITHOUT pulling in `result.ts`'s own `provider/provider.types.js`
 * import (`cron-loop-shape.test.ts`'s structural boundary forbids the cron
 * process's import graph from ever reaching `provider/**`, even via a
 * type-only import - the walker does not distinguish `import type` from a
 * value import). `result-pause.ts` has no provider dependency at all, so it
 * is the natural shared home; `result.ts` re-exports this same binding for
 * its own existing callers (no behavior change there).
 */
export const PAUSE_REASON_BY_CLASS: Readonly<Record<string, PauseReasonInput>> = Object.freeze({
  restricted: 'provider_restriction',
  unknown: 'unknown_signal',
});

export interface PauseInstanceForResultInput {
  clientId: string;
  instanceId: string;
  pauseReason: PauseReasonInput;
}

export async function pauseInstanceForResult(
  tx: TenantQueryable,
  input: PauseInstanceForResultInput,
): Promise<void> {
  await tx.query(
    `UPDATE whatsapp_instances SET health_state = 'paused', pause_reason = $1, paused_at = now(), needs_user_action = true
      WHERE id = $2
        AND client_id = $3
        AND deleted_at IS NULL
        AND (health_state IS DISTINCT FROM 'paused' OR pause_reason IS DISTINCT FROM $1::pause_reason)`,
    [input.pauseReason, input.instanceId, input.clientId],
  );
}
