import { bindQueryParams, loadQuery } from '@wp/db';
import { logger } from '@wp/server-kit';
import type { CollectCtx } from './signals/types.js';
import { toCount } from './signals/window-row.js';

/**
 * send-history-30d.ts (P16 fix round, CRITICAL 2) - loads
 * `db/queries/health-send-history-30d.sql`'s single-row 30-day
 * sent/failed/delivered summary, read ONLY on the hard-signal-pause path
 * (`fast-lane.ts#onConnectionUpdate`, `HealthEvaluator.ts`'s CRITICAL->pause
 * branch) - never on the 5-minute evaluator tick's hot scoring path, so this
 * is a separate query/loader from `signals/window-row.ts`'s shared
 * `health-signal-windows.sql` fetch (that file's own header: one round trip
 * per collect() call, shared by all twelve signals - a pause-time-only
 * aggregate does not belong there).
 *
 * COUNTS ONLY (no PII) - the returned shape is exactly
 * `hard-signal-pause.ts`'s own `sendHistory30d: Readonly<Record<string,
 * number>>` input type.
 *
 * DEGRADED-READ MARKER (P16 fix round, Fix 1): `fetchSendHistory30dSafe` is
 * the ONE caller-facing entry point for both hard-signal-pause call sites
 * (`fast-lane.ts#onConnectionUpdate`, `HealthEvaluator.ts`'s CRITICAL->pause
 * branch, kept here rather than duplicated in each - `HealthEvaluator.ts`
 * has no line budget left, module doc there). A pause decision must never be
 * lost to an unrelated read failure (core invariant 2: fail-safe means the
 * PAUSE wins, not the evidence enrichment around it) - `fetchSendHistory30d`
 * itself still throws on a malformed/failed read (never on a legitimate
 * zero-sends-in-30d instance: the query is a `count(*)` aggregate, which
 * always returns exactly one row regardless of how many rows it counted;
 * the throw fires only when the round trip itself failed - timeout, dropped
 * grant, lock contention - and a driver/network error surfaced instead of a
 * row). `fetchSendHistory30dSafe` catches exactly that failure, logs it
 * (ids only, never the error's raw provider payload), and returns the
 * DEGRADED MARKER shape `{ sent_30d: -1, failed_30d: -1, delivered_30d: -1 }`
 * - a value no real count can ever produce, so it is unambiguous in the
 * `pacing_events.to_value.send_history_30d` JSON that this pause's 30-day
 * history was unavailable at pause time, not "zero activity".
 */
export interface SendHistory30d extends Record<string, number> {
  sent_30d: number;
  failed_30d: number;
  delivered_30d: number;
}

interface RawRow extends Record<string, unknown> {
  sent_30d: string | number;
  failed_30d: string | number;
  delivered_30d: string | number;
}

export async function fetchSendHistory30d(ctx: CollectCtx): Promise<SendHistory30d> {
  const query = await loadQuery('health-send-history-30d');
  const params = bindQueryParams(query, {
    client_id: ctx.clientId,
    instance_id: ctx.instanceId,
    now: ctx.now(),
  });
  const result = await ctx.sql.query<RawRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      'fetchSendHistory30d: health-send-history-30d.sql returned zero rows (expected one)',
    );
  }
  return {
    sent_30d: toCount(row.sent_30d),
    failed_30d: toCount(row.failed_30d),
    delivered_30d: toCount(row.delivered_30d),
  };
}

/** The degraded-read marker (module doc) - no real 30-day count can be negative. */
export const SEND_HISTORY_30D_UNAVAILABLE: SendHistory30d = Object.freeze({
  sent_30d: -1,
  failed_30d: -1,
  delivered_30d: -1,
});

/**
 * Fail-safe wrapper (module doc, "DEGRADED-READ MARKER"): never throws. The
 * pause it feeds must commit even when this read fails.
 */
export async function fetchSendHistory30dSafe(ctx: CollectCtx): Promise<SendHistory30d> {
  try {
    return await fetchSendHistory30d(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { instance_id: ctx.instanceId, client_id: ctx.clientId },
      `fetchSendHistory30d: read failed, pausing with degraded history marker: ${message}`,
    );
    return SEND_HISTORY_30D_UNAVAILABLE;
  }
}
