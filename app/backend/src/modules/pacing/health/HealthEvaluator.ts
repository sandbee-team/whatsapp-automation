import type { TenantQueryable } from '@wp/db';
import type { Layers } from '@wp/domain';
import { readSystemProfileLayer } from '../../../engine/pacing/warmup-evaluator.js';
import { warmupTierLayer } from '../../../engine/pacing/warmup-evaluator-row.js';
import type { PacingConfigQueryable } from '../../../engine/pacing/config-service.js';
import { computeHealthScore } from './score.js';
import { decideBand, type HealthBand } from './bands.js';
import { applyBandChange, writeBandChangeSuppressed } from './apply-band.js';
import { applyHardSignalPause } from './hard-signal-pause.js';
import { decideEvalTier } from './eval-tier-ladder.js';
import {
  effectiveLimitsFrom,
  readInstanceRow,
  readPacingStateRow,
  readRecentBandChanges,
} from './health-evaluator-reads.js';
import { fetchSendHistory30dSafe } from './send-history-30d.js';

/**
 * HealthEvaluator.ts (P16 Unit C, step 6) - `evaluate(ctx, instanceId)` runs
 * ONE evaluator tick end-to-end inside the caller's own `withTenant`
 * transaction (`ctx.sql`): collect (signals/registry via `computeHealthScore`,
 * EWMA-primed from `instance_pacing_state.last_evidence`) -> band decision
 * (`bands.ts`, hysteresis/dwell/flap-cap driven by `recentBandChanges` read
 * from `pacing_events` BAND_CHANGE rows, never a counter column) -> apply
 * (`apply-band.ts`, which itself reuses `updatePacingConfig({kind:
 * 'health_band'})` for the `eff_*`/audit/BAND_CHANGE write - never
 * duplicated here) -> bookkeeping write (`last_evidence`/`health_score`/
 * `health_band(+since)`/`last_band_improved_at`/`eval_due_at`/`eval_tier`).
 * Read helpers live in the sibling `health-evaluator-reads.ts` (max-lines
 * split, same idiom as `session-worker-discovery-wiring.ts`).
 *
 * PAUSED IS STRUCTURAL, NOT AN IF-COMMENT: when `health_state = 'paused'`,
 * this function still scores and writes a sample (a direct
 * `instance_health_samples` INSERT, bypassing `apply-band.ts`'s `eff_*`
 * rewrite entirely) but NEVER calls `applyBandChange` - there is no code
 * path from a paused read to `updatePacingConfig` in this function; the
 * early-return below is what makes that true, not a runtime flag check
 * layered on top of the normal path.
 *
 * CRITICAL BAND -> PAUSE goes through `hard-signal-pause.ts` with
 * `pause_reason: 'health_critical'`, never through `apply-band.ts` (the
 * evaluator itself NEVER writes `health_state` upward or applies a CRITICAL
 * band's `eff_*` multipliers via the normal band-change path).
 *
 * `eval_due_at`/`eval_tier` (P16 Unit E, step 9): every tick's bookkeeping
 * write now resolves BOTH columns via `eval-tier-ladder.ts#decideEvalTier` -
 * tier 1 (60s) when the band changed THIS tick or within the last hour, tier
 * 3 (30min) when `health_state` is paused/parked/logged_out, tier 2 (5min)
 * otherwise. This replaces the P16 Unit C placeholder (a flat 5-minute
 * delay, `eval_tier` left unchanged) - see `eval-tier-ladder.ts`'s own doc
 * for the full ladder and why `lastSendOutcomeAtMs` is passed `null` here
 * (no "last send outcome" timestamp column exists on `instance_pacing_state`
 * today; the fast-lane/send-outcome seams re-arm tier 1 immediately via
 * `dirty-set.ts#markDirty` on every real send/fail/disconnect, so this
 * tick's OWN decision only needs to know whether that activity has since
 * gone idle long enough to fall back to tier 2).
 */

const RECENT_BAND_CHANGES_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface HealthEvaluatorClock {
  now(): number;
}

export interface HealthEvaluatorCtx {
  sql: TenantQueryable & PacingConfigQueryable;
  clientId: string;
  clock: HealthEvaluatorClock;
}

export interface HealthEvaluatorResult {
  band: HealthBand;
  score: number;
  changed: boolean;
  paused: boolean;
}

/** Writes the sample row directly - used on BOTH the changed and unchanged/paused paths, never routed through `apply-band.ts` (which also rewrites `eff_*`, wrong for a no-op tick). */
async function writeHealthSample(
  sql: TenantQueryable,
  input: {
    clientId: string;
    instanceId: string;
    score: number;
    band: HealthBand;
    evidence: unknown;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO instance_health_samples (id, client_id, instance_id, score, band, evidence)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     -- client_id = $1`,
    [input.clientId, input.instanceId, input.score, input.band, JSON.stringify(input.evidence)],
  );
}

async function writeBookkeeping(
  sql: TenantQueryable,
  input: {
    clientId: string;
    instanceId: string;
    score: number;
    band: HealthBand;
    bandChanged: boolean;
    /** WARNING 5 fix (P16 fix round): true only on a CHANGED, LOOSENING tick - `last_band_improved_at` is denormalized display data only; the anti-flap budget authority stays `pacing_events` BAND_CHANGE rows (module doc unchanged). */
    bandLoosened: boolean;
    evidence: unknown;
    nowMs: number;
    healthState: string;
    bandChangedAtMs: number | null;
  },
): Promise<void> {
  const { tier, nextEvalDueAtMs } = decideEvalTier({
    nowMs: input.nowMs,
    healthState: input.healthState,
    bandChanged: input.bandChanged,
    bandChangedAtMs: input.bandChangedAtMs,
    // No "last send outcome" timestamp column exists yet - see module doc.
    lastSendOutcomeAtMs: null,
  });

  await sql.query(
    `UPDATE instance_pacing_state SET
        last_evidence = $3,
        health_score = $4,
        health_band = $5,
        health_band_since = CASE WHEN $6::boolean THEN $7::timestamptz ELSE health_band_since END,
        last_band_improved_at = CASE WHEN $10::boolean THEN $7::timestamptz ELSE last_band_improved_at END,
        eval_due_at = $8,
        eval_tier = $9,
        updated_at = now()
      WHERE instance_id = $1 AND client_id = $2`,
    [
      input.instanceId,
      input.clientId,
      JSON.stringify(input.evidence),
      input.score,
      input.band,
      input.bandChanged,
      new Date(input.nowMs),
      new Date(nextEvalDueAtMs),
      tier,
      input.bandLoosened,
    ],
  );
}

/** Runs one evaluator tick for `instanceId`. See module doc for the full ordering/paused/CRITICAL contract. */
export async function evaluate(
  ctx: HealthEvaluatorCtx,
  instanceId: string,
): Promise<HealthEvaluatorResult> {
  const nowMs = ctx.clock.now();
  const now = () => new Date(nowMs);

  const [pacingState, instance] = await Promise.all([
    readPacingStateRow(ctx.sql, ctx.clientId, instanceId),
    readInstanceRow(ctx.sql, ctx.clientId, instanceId),
  ]);

  const scoreResult = await computeHealthScore(
    { sql: ctx.sql, instanceId, clientId: ctx.clientId, now },
    pacingState.last_evidence ?? {},
  );

  const recentBandChanges = await readRecentBandChanges(
    ctx.sql,
    ctx.clientId,
    instanceId,
    nowMs - RECENT_BAND_CHANGES_LOOKBACK_MS,
  );

  const decision = decideBand({
    currentBand: pacingState.health_band,
    score: scoreResult.score,
    nowMs,
    bandSinceMs: pacingState.health_band_since?.getTime() ?? nowMs,
    lastHardSignalAtMs: pacingState.last_hard_signal_at?.getTime() ?? null,
    recentBandChanges,
  });

  // Most recent BAND_CHANGE on record (any earlier tick) - eval-tier-ladder's
  // own 1h lookback input; `recentBandChanges` is already ordered ASC.
  const bandChangedAtMs = recentBandChanges.at(-1)?.atMs ?? null;

  const isPaused = instance.health_state === 'paused';

  if (isPaused) {
    // Structural guard (module doc): scoring/sampling continue, but no band
    // write, no eff_* rewrite, no health_state change - ever, from here.
    await writeHealthSample(ctx.sql, {
      clientId: ctx.clientId,
      instanceId,
      score: scoreResult.score,
      band: pacingState.health_band,
      evidence: scoreResult.evidence,
    });
    await writeBookkeeping(ctx.sql, {
      clientId: ctx.clientId,
      instanceId,
      score: scoreResult.score,
      band: pacingState.health_band,
      bandChanged: false,
      bandLoosened: false,
      evidence: scoreResult.evidence,
      nowMs,
      healthState: instance.health_state,
      bandChangedAtMs,
    });
    return {
      band: pacingState.health_band,
      score: scoreResult.score,
      changed: false,
      paused: true,
    };
  }

  if (decision.suppressedByFlap) {
    await writeBandChangeSuppressed(ctx.sql, {
      clientId: ctx.clientId,
      instanceId,
      currentBand: pacingState.health_band,
      reason: decision.reason,
    });
  }

  if (decision.changed && decision.band === 'critical') {
    // CRITICAL never applies via the normal band-change path (module doc) -
    // hard-signal-pause.ts owns this, with its own distinct pause_reason.
    // CRITICAL 2 fix (P16 fix round): effectiveLimits/sendHistory30d are the
    // REAL eff_* limits and a real 30-day aggregate, never a stub. Fix 1
    // (P16 fix round): the *Safe wrapper degrades to a marker on failure
    // instead of throwing - the pause must still commit (core invariant 2).
    const sendHistory30d = await fetchSendHistory30dSafe({
      sql: ctx.sql,
      instanceId,
      clientId: ctx.clientId,
      now,
    });
    await applyHardSignalPause(ctx.sql, {
      clientId: ctx.clientId,
      instanceId,
      pauseReason: 'health_critical',
      evidence: scoreResult.evidence,
      effectiveLimits: effectiveLimitsFrom(pacingState),
      warmupTier: pacingState.warmup_tier,
      accountAgeDays: Math.floor((nowMs - instance.created_at.getTime()) / (24 * 60 * 60 * 1000)),
      sendHistory30d,
      band: decision.band,
    });
  } else if (decision.changed) {
    const systemProfile = await readSystemProfileLayer(ctx.sql, ctx.clientId, instanceId);
    const layers: Omit<Layers, 'healthBand'> = {
      systemProfile,
      warmupTier: warmupTierLayer(pacingState.warmup_tier),
    };
    await applyBandChange({
      sql: ctx.sql,
      clientId: ctx.clientId,
      instanceId,
      fromBand: pacingState.health_band,
      toBand: decision.band,
      layers,
      score: scoreResult.score,
      evidence: scoreResult.evidence,
      reason: decision.reason,
      clock: ctx.clock,
    });
  } else {
    await writeHealthSample(ctx.sql, {
      clientId: ctx.clientId,
      instanceId,
      score: scoreResult.score,
      band: decision.band,
      evidence: scoreResult.evidence,
    });
  }

  await writeBookkeeping(ctx.sql, {
    clientId: ctx.clientId,
    instanceId,
    score: scoreResult.score,
    band: decision.band,
    bandChanged: decision.changed,
    bandLoosened: decision.changed && decision.direction === 'loosen',
    evidence: scoreResult.evidence,
    nowMs,
    healthState: instance.health_state,
    bandChangedAtMs,
  });

  return {
    band: decision.band,
    score: scoreResult.score,
    changed: decision.changed,
    paused: decision.changed && decision.band === 'critical',
  };
}
