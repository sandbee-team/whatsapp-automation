import type { HealthBand, PacingLayer } from '@wp/domain';
import { WARMUP_LADDER } from '@wp/domain';

/**
 * warmup-evaluator-row.ts (P13a warmup-ladder, FIX ROUND file-length split) -
 * split out of `warmup-evaluator.ts` to stay under the workspace's 300-line
 * max-lines lint rule (the `session-cost-feedback-timer.ts` split idiom): the
 * `wp_warmup_scan_due` row shape plus its pure, no-I/O helpers (local-date
 * math, the warm-up-tier ladder layer lookup). Nothing here is warm-up-
 * evaluator-specific behaviour beyond "shapes and pure functions the
 * evaluator's own DB-driving code calls" - no clock read, no query, no
 * decision logic (that stays in `warmup-decision.ts`).
 */

/**
 * P13a re-review (finding 4) - trimmed to exactly the columns
 * `runOnePacingEvaluatorSweep`/`evaluateOneInstance` reads. `wp_warmup_
 * scan_due` (migration 0035) projects this exact set - it no longer carries
 * `warmup_tier_since`, `config_version` or any `eff_*` column, none of which
 * this evaluator ever read (those are the config-service's own read/write
 * surface, resolved separately via `resolveEffective`/`readSystemProfile
 * Layer`).
 */
export interface DueInstanceRow extends Record<string, unknown> {
  instance_id: string;
  client_id: string;
  pacing_timezone: string;
  warmup_tier: number;
  warmup_started_at: Date | null;
  health_band: HealthBand;
  health_state: string;
}

/** Reads the wall-clock Y/M/D (in `timeZone`) for the instant `epochMs` - same `Intl` idiom as `retry-at.ts#localDateParts` (DST-correct, no timezone library). */
function localDateParts(epochMs: number, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Elapsed CALENDAR days between two instants in `timeZone`, start day = day 1 (a `startMs` instant is day 1 of itself, not day 0). */
export function elapsedLocalDays(startMs: number, nowMs: number, timeZone: string): number {
  const start = localDateParts(startMs, timeZone);
  const now = localDateParts(nowMs, timeZone);
  const startUtcMidnight = Date.UTC(start.y, start.m - 1, start.d);
  const nowUtcMidnight = Date.UTC(now.y, now.m - 1, now.d);
  return Math.round((nowUtcMidnight - startUtcMidnight) / (24 * 60 * 60 * 1000)) + 1;
}

/** The warm-up-tier layer `resolveEffective()`'s `warmupTier` input expects, for the tier the evaluator is deciding to move TO. */
export function warmupTierLayer(tier: number): PacingLayer {
  const row = WARMUP_LADDER.find((t) => t.tier === tier) ?? WARMUP_LADDER[0]!;
  return {
    dailyCap: row.dailyCap,
    hourlyCap: row.hourlyCap,
    newConvCap: row.newConvCap,
    gapMinMs: row.gapMinMs,
    gapMaxMs: row.gapMaxMs,
    coldRatioMax: row.coldRatioMax,
    groupDailyCap: row.groupDailyCap,
    blockLinkFirst: row.blockLinkFirst,
    blockGroupActions: row.blockGroupActions,
  };
}
