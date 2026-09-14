import type { TenantQueryable } from '@wp/db';
import { setInstanceHealthStateGauge } from './metrics.js';
import type { UserActor } from './transitions.js';

/**
 * human-resume.ts (P16 Unit C, step 7) - the ONLY function that can take
 * `whatsapp_instances.health_state` out of `'paused'`. Its `actor` parameter
 * is typed as `transitions.ts`'s own `UserActor` (`{type:'user', userId}`) -
 * a `SystemActor`/`ApiKeyActor` argument is a compile-time error at the call
 * site, exactly mirroring `exitPaused`'s own "not representable without a
 * real user" contract, extended here to the health-critical pause path.
 *
 * POST-RESUME HEALTH STATE: `'degraded'`, not `'connected'` - FSM evidence
 * (P08's `@wp/domain` `session-fsm.ts`): the socket is NOT re-established by
 * this write alone (a human resume only flips the DB row; the session-worker
 * fleet must still re-grab the lease and open a fresh Baileys connection
 * before any send can happen), so claiming `'connected'` here would be
 * dishonest - `onOpen` (`engine/session/runner-connection-update.ts`) is the
 * ONLY place that legitimately writes `'connected'`, once a socket has
 * actually opened. `'degraded'` is the FSM-honest "resumed, not yet
 * reconnected" state: `discover-instances.sql`'s own eligibility predicate
 * (`health_state <> 'logged_out'`) already picks up ANY non-logged-out,
 * non-paused state for a fresh discovery/lease-grab attempt, so a
 * `'degraded'` instance re-enters the connect pipeline on the very next
 * discovery cycle exactly like any other degraded-but-reconnectable
 * instance. `LEGAL_HEALTH_TRANSITIONS` in `session-fsm.ts` is scoped to
 * `applyDisconnect`'s own transition-producing functions (this module does
 * not call `applyDisconnect`, and is not bound by that table), so this is a
 * deliberate, separate, FSM-consistent choice - not an FSM violation.
 *
 * NEVER writes `audit_logs`, `outbox_events`, or a wake - per this unit's
 * dispatch, that is the HTTP layer's (Unit D, parallel-next) responsibility,
 * once it has a real actor/route context to attribute those writes to. This
 * module's only job is the ONE conditional `whatsapp_instances` write, and it
 * runs inside the CALLER's own transaction (never opens one itself).
 *
 * IDEMPOTENT + CONDITIONAL (core invariant 3): the WHERE clause only matches
 * a row that is currently `health_state = 'paused'` - a repeat call (e.g. a
 * double-submitted resume) is a zero-row no-op, reported via
 * `resumed: false`, never a second write.
 */

export interface HumanResumeInput {
  clientId: string;
  instanceId: string;
  /** Only a real user can resume a paused instance - see module doc. */
  actor: UserActor;
}

export interface HumanResumeResult {
  /** `false` when the instance was not `health_state = 'paused'` at write time - a clean no-op, not an error. */
  resumed: boolean;
}

export async function humanResume(
  tx: TenantQueryable,
  input: HumanResumeInput,
): Promise<HumanResumeResult> {
  void input.actor; // typed guard only (see module doc) - never read past the type system here.

  const result = await tx.query(
    `UPDATE whatsapp_instances SET
        health_state = 'degraded',
        pause_reason = NULL,
        needs_user_action = false,
        user_action_reason = NULL,
        updated_at = now()
      WHERE id = $1
        AND client_id = $2
        AND deleted_at IS NULL
        AND health_state = 'paused'`,
    [input.instanceId, input.clientId],
  );

  const resumed = (result.rowCount ?? 0) > 0;
  if (resumed) {
    setInstanceHealthStateGauge({
      clientId: input.clientId,
      instanceId: input.instanceId,
      healthState: 'degraded',
    });
  }

  return { resumed };
}
