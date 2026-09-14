import type { CollectCtx, CollectedEvidence, Signal } from './types.js';
import { fetchWindowRow } from './window-row.js';

/**
 * signals/hard-restriction.ts (P16 Unit B, step 3) - the OVERRIDE signal
 * (design canon: "override, no weight"). `collect` reads
 * `last_hard_signal_audit_at` (the most recent `RESTRICTION_SIGNAL`-reason
 * audit row for this instance - see `health-signal-windows.sql`'s own
 * header) and reports it as a boolean-shaped ratio: `value` is `1` when a
 * restriction landed inside the LAST 24H (the window `bands.ts`'s own
 * loosening rule cares about - "no hard restriction signal in last 24h"),
 * else `0`. `severity` is the trivial identity (`value` is already `0` or
 * `1`) - `score.ts` never multiplies this by `weight` (weight is `0` here
 * and this key is excluded from `WEIGHT_SUM`); it instead branches on this
 * signal's raw evidence to apply the override directly.
 *
 * No min-evidence gate (design table: "min evidence: none") - a SINGLE
 * restriction observation is authoritative, never diluted by a sample-size
 * floor. Always measured (never `'unmeasured'`): the absence of any
 * restriction row is itself a valid, fully-evidenced `0`.
 */
const HARD_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;

async function collect(ctx: CollectCtx): Promise<CollectedEvidence> {
  const row = await fetchWindowRow(ctx);
  const lastSignalAt = row.last_hard_signal_audit_at;
  const withinWindow =
    lastSignalAt !== null && ctx.now().getTime() - lastSignalAt.getTime() <= HARD_SIGNAL_WINDOW_MS;
  const value = withinWindow ? 1 : 0;
  return { numerator: value, denominator: 1, value };
}

export const hardRestrictionSignal: Signal = {
  key: 'hard_restriction',
  window: 'event',
  weight: 0,
  minEvidence: 0,
  scored: true,
  collect,
  severity: (value) => (value >= 1 ? 1 : 0),
};
