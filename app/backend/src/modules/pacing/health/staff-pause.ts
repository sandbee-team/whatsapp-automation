import type { TenantQueryable } from '@wp/db';

/**
 * staff-pause.ts (P28 Unit U3b, step 5) - `staffPause`, the ONE writer of a
 * STAFF-initiated instance pause (`POST /internal/v1/instances/:id/pause`).
 * A third member of the small allow-listed set of `whatsapp_instances.
 * health_state` writers (`scripts/check-health-writers.ts`'s
 * `HEALTH_STATE_WRITER_ALLOW_LIST`), alongside `hard-signal-pause.ts` (the
 * signal-driven pause) and `human-resume.ts` (the only paused-EXIT writer).
 *
 * WHY A SEPARATE WRITER, not a `pause_reason` parameter on
 * `applyHardSignalPause`: that function's write is a RESTRICTION/health
 * pause - it sets `needs_user_action = true` and
 * `user_action_reason = 'RESTRICTION_SIGNAL'`, writes a `pacing_events`
 * evidence row carrying the 12-signal vector, and emits an
 * `instance_paused` notify with `requiresUserAction`. A staff pause is the
 * OPPOSITE shape on every one of those points: there is no provider signal
 * and no evidence vector, and the tenant has NOTHING to do about it
 * (`needs_user_action = false`, `user_action_reason = NULL`) - WP support
 * decided this, and only WP support can undo it. Folding the two into one
 * function would have made every one of those fields conditional on a flag,
 * which is exactly how a restriction pause ends up mislabelled as an admin
 * action (or vice versa) in a tenant's own audit trail.
 *
 * `'admin_action'` is already a legal `pause_reason` enum member (migration
 * 0001) - no schema change.
 *
 * SCOPE (deliberately narrow, mirroring `human-resume.ts`): this module
 * writes ONLY the ONE conditional `whatsapp_instances` UPDATE - it does NOT
 * set the `wp_instance_health_state` gauge itself (C1 review round 2 MINOR
 * fix): it runs inside the CALLER's transaction, and a gauge write here
 * would observe a `'paused'` state that has not committed - if the
 * surrounding `withStaffMutation` transaction later rolls back, the gauge
 * would keep lying `'paused'` until an unrelated future transition happened
 * to correct it. The caller (`modules/internal/routes/instances.ts`) sets
 * the gauge in `tx.afterCommit`, the SAME deferral idiom its resume route
 * already uses for `publishWake`. This module also writes NO `audit_logs`
 * row, NO `pacing_events` row, NO outbox event and NO notification - the
 * route owns all of that, inside `withStaffMutation`'s own transaction,
 * because only it has the resolved staff actor and reason to attribute them
 * to. It runs inside the CALLER's transaction and never opens one.
 *
 * LEGAL FROM-STATES: `connected` and `degraded` only - the two states from
 * which sending can actually happen, so pausing them is what stops sends.
 * `logged_out`/`never_linked` are refused by the caller as 409
 * `INVALID_STATE` (there is nothing to pause: no session exists, and moving
 * such a row to `paused` would falsely imply staff stopped a working
 * number). An ALREADY-paused instance is a zero-row no-op reported as
 * `changed:false` (core invariant 3), never a second write - and critically,
 * never an overwrite of an existing `provider_restriction` pause_reason with
 * `admin_action`, which would erase the record of WHY sending stopped.
 *
 * QUEUED JOBS ARE NEVER TOUCHED (core invariant 5): the only target of the
 * statement below is `whatsapp_instances`. `claim-jobs.sql`'s own
 * `i.health_state = 'connected'` predicate is what stops claiming, so the
 * queue simply stops draining - nothing is failed, cancelled or deleted.
 */

export interface StaffPauseInput {
  clientId: string;
  instanceId: string;
  /** The resolved `staff_users.id` - recorded by the CALLER's `audit_logs` row, not by this module (see module doc). */
  staffId: string;
}

export interface StaffPauseResult {
  /** `false` when the instance was not in `connected`/`degraded` at write time - the caller distinguishes "already paused" (a no-op) from an illegal from-state by reading the row first. */
  changed: boolean;
}

/** Applies the ONE conditional staff-pause write - see module doc for the full from-state/scope contract. */
export async function staffPause(
  tx: TenantQueryable,
  input: StaffPauseInput,
): Promise<StaffPauseResult> {
  void input.staffId; // attributed by the caller's audit row (module doc) - never read past the type system here.

  const result = await tx.query(
    `UPDATE whatsapp_instances SET
        health_state = 'paused',
        pause_reason = 'admin_action',
        paused_at = now(),
        needs_user_action = false,
        user_action_reason = NULL,
        updated_at = now()
      WHERE id = $1
        AND client_id = $2
        AND deleted_at IS NULL
        AND health_state IN ('connected', 'degraded')`,
    [input.instanceId, input.clientId],
  );

  const changed = (result.rowCount ?? 0) > 0;

  return { changed };
}
