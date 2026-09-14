import type { TenantQueryable } from '@wp/db';
import type { Layers } from '@wp/domain';
import { readSystemProfileLayer } from '../../../engine/pacing/warmup-evaluator.js';
import { warmupTierLayer } from '../../../engine/pacing/warmup-evaluator-row.js';
import type { PacingConfigQueryable } from '../../../engine/pacing/config-service.js';
import { applyBandChange } from './apply-band.js';
import { applyHardSignalPause } from './hard-signal-pause.js';
import { markDirty } from './dirty-set.js';
import {
  effectiveLimitsFrom,
  readInstanceRow,
  readPacingStateRow,
} from './health-evaluator-reads.js';
import { computeHealthScoreSafe } from './score.js';
import { fetchSendHistory30dSafe } from './send-history-30d.js';
import type { HealthBand } from './bands.js';

/**
 * fast-lane.ts (P16 Unit C, step 6; P16 Unit E, step 9) - the two
 * immediate-reaction entry points the phase's "fast-lane facts" require,
 * called from the SEND-OUTCOME and CONNECTION.UPDATE paths directly (never
 * from the 5-minute evaluator tick): `onSendOutcome` forces AT LEAST WATCH
 * within one tick on a `rate_limited` send outcome; `onConnectionUpdate`
 * pauses within one tick on a hard-restriction-shaped disconnect (403/402/
 * 406/logged-out-restriction). Both run inside the CALLER's own `withTenant`
 * transaction - neither opens one itself, matching
 * `apply-band.ts`/`hard-signal-pause.ts`.
 *
 * Neither function reads `bands.ts`'s full scoring/dwell machinery - a fast
 * lane is deliberately an OVERRIDE, not a scored decision: `onSendOutcome`
 * only ever WIDENS to at least WATCH (never loosens, never skips past an
 * already-worse band), and `onConnectionUpdate`'s hard-restriction case
 * pauses unconditionally, matching `bands.ts`'s own "tightening applies on
 * the first crossing tick, no dwell/hysteresis/flap-cap" rule for the
 * downward direction.
 *
 * DIRTY-SET WIRING (Unit E, step 9): both entry points call `dirty-set.ts#
 * markDirty` UNCONDITIONALLY, before any classification branch - a real send
 * outcome or connection-update event has happened either way, so the
 * instance's next due-scan cadence is re-armed to tier 1 (60s) regardless of
 * whether THIS particular outcome/code triggered a band override. This is
 * the ONLY dirty-set call site for these two seams (the evaluator tick's own
 * end-of-tick tier decision, `eval-tier-ladder.ts`, is a SEPARATE write that
 * runs afterward and may fall back to a slower tier once activity goes
 * idle).
 */

const WATCH_BAND: HealthBand = 'watch';
const BAND_RANK: Readonly<Record<HealthBand, number>> = Object.freeze({
  healthy: 0,
  watch: 1,
  degraded: 2,
  critical: 3,
});

export interface FastLaneCtx {
  sql: TenantQueryable & PacingConfigQueryable;
  clientId: string;
  clock: { now(): number };
}

/**
 * A `rate_limited` send outcome: if the instance is currently HEALTHY,
 * force it to WATCH immediately (via `apply-band.ts`, same one-transaction
 * `eff_*`/audit/BAND_CHANGE/sample/outbox write the tick uses). Already
 * WATCH/DEGRADED/CRITICAL is left untouched here - a fast-lane override only
 * ever widens toward the worse direction, never re-decides a band the
 * scored evaluator already tightened further.
 */
export async function onSendOutcome(
  ctx: FastLaneCtx,
  input: { instanceId: string; errorClass: string },
): Promise<{ bandForced: boolean }> {
  await markDirty(ctx.sql, { clientId: ctx.clientId, instanceId: input.instanceId });

  if (input.errorClass !== 'rate_limited') {
    return { bandForced: false };
  }

  const pacingState = await readPacingStateRow(ctx.sql, ctx.clientId, input.instanceId);
  if (BAND_RANK[pacingState.health_band] >= BAND_RANK[WATCH_BAND]) {
    return { bandForced: false };
  }

  const systemProfile = await readSystemProfileLayer(ctx.sql, ctx.clientId, input.instanceId);
  const layers: Omit<Layers, 'healthBand'> = {
    systemProfile,
    warmupTier: warmupTierLayer(pacingState.warmup_tier),
  };

  await applyBandChange({
    sql: ctx.sql,
    clientId: ctx.clientId,
    instanceId: input.instanceId,
    fromBand: pacingState.health_band,
    toBand: WATCH_BAND,
    layers,
    // WARNING 9 fix (P16 fix round): the fast lane forces a BAND override,
    // never a scored decision (module doc) - it must never fabricate a
    // precise score value. Write the instance's CURRENT stored score
    // unchanged; the forcing itself stays visible via `reason` below and the
    // `fast_lane` evidence key.
    score: Number(pacingState.health_score),
    evidence: {
      fast_lane: {
        numerator: 1,
        denominator: 1,
        value: 1,
        severity: 1,
        weightApplied: 0,
        unmeasured: false,
      },
    },
    reason: 'fast_lane_rate_limited',
    clock: ctx.clock,
  });

  return { bandForced: true };
}

const HARD_RESTRICTION_CODES = new Set([402, 403, 406]);

/**
 * A connection-close disconnect code shaped like a hard restriction
 * (402/403/406, or an explicit `loggedOutRestriction` flag for a stream
 * error the caller has already classified) - pauses immediately via
 * `hard-signal-pause.ts` with `pause_reason: 'provider_restriction'`. A
 * code outside this set is a no-op here (the normal reconnect/disconnect
 * FSM in `engine/session/runner-disconnect.ts` owns every other code).
 */
export async function onConnectionUpdate(
  ctx: FastLaneCtx,
  input: { instanceId: string; disconnectCode: number },
): Promise<{ paused: boolean }> {
  await markDirty(ctx.sql, { clientId: ctx.clientId, instanceId: input.instanceId });

  if (!HARD_RESTRICTION_CODES.has(input.disconnectCode)) {
    return { paused: false };
  }

  const [pacingState, instance] = await Promise.all([
    readPacingStateRow(ctx.sql, ctx.clientId, input.instanceId),
    readInstanceRow(ctx.sql, ctx.clientId, input.instanceId),
  ]);

  // CRITICAL 2 fix (P16 fix round): the pause row must carry the REAL
  // 12-signal evidence vector, not a single-key stub - computed via the same
  // collect+score path the evaluator uses (`computeHealthScore`, EWMA-primed
  // from this row's own `last_evidence`), plus the real `eff_*` limits and a
  // real 30-day send-history aggregate.
  //
  // Fix 1 (P16 fix round): both reads go through their `*Safe` wrapper - an
  // unrelated read failure degrades to an `unavailable`/marker evidence
  // shape (score.ts / send-history-30d.ts) rather than throwing and rolling
  // back the pause itself (core invariant 2: the pause wins over its own
  // evidence enrichment).
  const now = () => new Date(ctx.clock.now());
  const scoreResult = await computeHealthScoreSafe(
    { sql: ctx.sql, instanceId: input.instanceId, clientId: ctx.clientId, now },
    pacingState.last_evidence ?? {},
  );
  const sendHistory30d = await fetchSendHistory30dSafe({
    sql: ctx.sql,
    instanceId: input.instanceId,
    clientId: ctx.clientId,
    now,
  });

  const result = await applyHardSignalPause(ctx.sql, {
    clientId: ctx.clientId,
    instanceId: input.instanceId,
    pauseReason: 'provider_restriction',
    evidence: scoreResult.evidence,
    effectiveLimits: effectiveLimitsFrom(pacingState),
    warmupTier: pacingState.warmup_tier,
    accountAgeDays: Math.floor(
      (ctx.clock.now() - instance.created_at.getTime()) / (24 * 60 * 60 * 1000),
    ),
    sendHistory30d,
    band: pacingState.health_band,
  });

  return { paused: result.paused };
}
