import { randomUUID } from 'node:crypto';
import type { TenantQueryable } from '@wp/db';
import { logger } from '@wp/server-kit';
import { emit } from '../../events/index.js';
import { notify } from '../../notifications/index.js';
import { bindHealthMetrics, setInstanceHealthStateGauge } from './metrics.js';
import type { ScoreEvidence } from './score.js';
import type { HealthBand } from './bands.js';

/**
 * hard-signal-pause.ts (P16 Unit C, step 7) - the ONE writer of a
 * signal-driven pause: either the `hard_restriction` override signal
 * firing, the `rate_limited` fast lane forcing at least WATCH-then-
 * escalation, or a CRITICAL band decision from the evaluator. Distinct
 * `pause_reason` per trigger (`'provider_restriction'` for a hard
 * restriction/fast-lane signal, `'health_critical'` for a CRITICAL-band
 * evaluator decision - both already legal `pause_reason` enum members,
 * migration 0001) but the SAME write shape and the SAME `hard_signal_pause`
 * `pacing_events` kind either way.
 *
 * NON-fence-guarded, client_id-scoped only (same idiom as
 * `engine/queue/result-pause.ts#pauseInstanceForResult` and
 * `instance-mark-infra-unavailable.sql`): the evaluator/fast-lane caller
 * runs in the cron/queue-worker process, never holding the session-worker's
 * lease/fence on this instance, so it cannot use the fence-guarded
 * `modules/instances/repo.ts#applyTransitionWrite` family
 * (`applyEngineTransition`) the session-worker's own runner uses for a
 * connection-level 403/402/406 close. This is a DELIBERATE, separate write
 * path for the health-signal-driven pause, not a rival to that one - both
 * converge on the same `whatsapp_instances.health_state='paused'` outcome.
 *
 * ONE TRANSACTION (task requirement): `tx` MUST be the caller's own
 * `withTenant` handle - every statement below (the `whatsapp_instances`
 * write, the `pacing_events` row, the `audit_logs` row, the outbox event)
 * commits together or not at all.
 *
 * NO PII IN THE EVIDENCE ROW (binding): `evidence` is `score.ts`'s own
 * `ScoreEvidence` (numerator/denominator/value/severity/weightApplied per
 * signal key) - counts, ratios, tiers, ages only, never a phone number, JID,
 * group subject, or message body. `sendHistory30d` is a plain count/ratio
 * summary object for the same reason - the caller (the evaluator/fast-lane)
 * assembles it from already-aggregated `send_attempts`/`message_jobs` rows,
 * never a raw row.
 *
 * GRANT GAP (reported, not fixed here): migration 0025 grants
 * `wp_scheduler` `UPDATE (health_state, pause_reason, paused_at,
 * needs_user_action)` on `whatsapp_instances` but NOT `user_action_reason`,
 * which this write also sets - and `audit_logs`/`outbox_events` INSERT are
 * `wp_app`-only (migrations 0013/0041). Whichever role the evaluator/fast-
 * lane process authenticates as needs all of these grants for this
 * transaction to succeed in production - a follow-up grants migration.
 */

export type HardSignalPauseReason = 'provider_restriction' | 'health_critical';

export interface HardSignalPauseInput {
  clientId: string;
  instanceId: string;
  pauseReason: HardSignalPauseReason;
  /** The complete 12-signal evidence vector at pause time (`score.ts`'s own `ScoreEvidence`) - ids/enums/numbers only, never PII. */
  evidence: ScoreEvidence;
  /** The `eff_*` limits in force at pause time. */
  effectiveLimits: Readonly<Record<string, number | string | null>>;
  warmupTier: number;
  /** Account age in whole days at pause time - a count, never a raw timestamp string that could leak provisioning metadata. */
  accountAgeDays: number;
  /** 30-day send-history summary - counts/ratios only. */
  sendHistory30d: Readonly<Record<string, number>>;
  band: HealthBand;
}

export interface HardSignalPauseResult {
  /** `false` when the instance was already paused for this exact reason - a clean idempotent no-op (core invariant 3); the `pacing_events`/`audit_logs`/outbox rows below are still skipped in that case, never double-written. */
  paused: boolean;
}

function buildEvidencePayload(input: HardSignalPauseInput): Record<string, unknown> {
  return {
    signals: input.evidence,
    effective_limits: input.effectiveLimits,
    warmup_tier: input.warmupTier,
    account_age_days: input.accountAgeDays,
    send_history_30d: input.sendHistory30d,
    band: input.band,
  };
}

/** Applies the hard-signal pause write, `pacing_events` row, `audit_logs` row, and outbox event - all on `tx`, all-or-nothing (module doc). Queued jobs are never touched (core invariant 5) - this statement's target is `whatsapp_instances` only, exactly like `result-pause.ts#pauseInstanceForResult`. */
export async function applyHardSignalPause(
  tx: TenantQueryable,
  input: HardSignalPauseInput,
): Promise<HardSignalPauseResult> {
  const pauseResult = await tx.query(
    `UPDATE whatsapp_instances SET
        health_state = 'paused',
        pause_reason = $1,
        paused_at = now(),
        needs_user_action = true,
        user_action_reason = 'RESTRICTION_SIGNAL',
        updated_at = now()
      WHERE id = $2
        AND client_id = $3
        AND deleted_at IS NULL
        AND (health_state IS DISTINCT FROM 'paused' OR pause_reason IS DISTINCT FROM $1::pause_reason)
      RETURNING id`,
    [input.pauseReason, input.instanceId, input.clientId],
  );

  await tx.query(
    `UPDATE instance_pacing_state SET last_hard_signal_at = now()
      WHERE instance_id = $1 AND client_id = $2`,
    [input.instanceId, input.clientId],
  );

  if ((pauseResult.rowCount ?? 0) === 0) {
    return { paused: false };
  }

  const evidencePayload = buildEvidencePayload(input);
  const pacingEventId = randomUUID();

  await tx.query(
    `INSERT INTO pacing_events (id, client_id, instance_id, kind, to_value, reason_codes)
     VALUES ($1, $2, $3, 'hard_signal_pause', $4, $5)
     -- client_id = $2`,
    [
      pacingEventId,
      input.clientId,
      input.instanceId,
      JSON.stringify(evidencePayload),
      [input.pauseReason],
    ],
  );

  await tx.query(
    `INSERT INTO audit_logs (client_id, actor_type, action, target_type, target_id, metadata)
     VALUES ($1, 'system', 'instance.paused', 'instance', $2, $3)
     -- client_id = $1`,
    [input.clientId, input.instanceId, JSON.stringify({ reason: 'RESTRICTION_SIGNAL' })],
  );

  // P17 U6 (step 5) - mandatory `instance_paused` notify, on the SAME tx,
  // only on this actual-transition branch (the no-op path already returned
  // above). transitionId = the `pacing_events` row this statement just
  // wrote - stable, non-wall-clock, and unique per real pause occurrence
  // (a repeat call for the SAME condition returns early above and never
  // reaches here, so this id is only ever minted once per transition).
  //
  // FAIL-SAFE LAYERING (P17 fix round F5, same swallow-and-log discipline as
  // `send-history-30d.ts#fetchSendHistory30dSafe`): the pause write above is
  // itself the fail-safe stop (core invariant 2) - a notify failure must
  // NEVER roll it back. `notify()`'s own `MAX_PAYLOAD_BYTES` pre-filter
  // (`notify.ts`'s own doc comment) is a cheap common-case catch, NOT a
  // guaranteed match for the DB's `notifications_payload_size` CHECK - a
  // failure here can be either `NotifyPayloadTooLargeError` (caught by the
  // pre-filter), the raw DB CHECK violation (a boundary payload the
  // pre-filter missed), or any other real SQL error; the SAVEPOINT below is
  // what actually backstops all three cases, not the pre-filter alone.
  //
  // SAVEPOINT, NOT A BARE TRY/CATCH (F2 correction round, same latent bug
  // caught in reconciler.ts's own notifyUnresolvedSendSafe - see that
  // function's own doc comment for the full explanation): a plain try/catch
  // around `notify()` catches the JS exception but NOT the Postgres
  // transaction's own ABORTED state once a real SQL statement (as opposed to
  // a pre-SQL typed validation error) fails inside it - the later `COMMIT`
  // would then silently no-op into a rollback, losing this pause write too.
  // `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` scopes the failure to just the
  // notify statement.
  await tx.query('SAVEPOINT instance_paused_notify');
  try {
    await notify(tx, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      kind: 'instance_paused',
      transitionId: pacingEventId,
      payload: { instanceId: input.instanceId, pauseReason: input.pauseReason },
      requiresUserAction: true,
    });
    await tx.query('RELEASE SAVEPOINT instance_paused_notify');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT instance_paused_notify');
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { client_id: input.clientId, instance_id: input.instanceId },
      `applyHardSignalPause: instance_paused notify failed, pause already applied on this tx: ${message}`,
    );
  }

  await emit(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    type: 'instance.paused',
    entityId: input.instanceId,
    payload: {
      instanceId: input.instanceId,
      pauseReason: input.pauseReason,
      needsUserAction: true,
    },
    fanout: ['sse', 'webhook'],
  });

  bindHealthMetrics().hardSignalPausesTotal.inc({ signal: input.pauseReason });
  setInstanceHealthStateGauge({
    clientId: input.clientId,
    instanceId: input.instanceId,
    healthState: 'paused',
  });

  return { paused: true };
}
