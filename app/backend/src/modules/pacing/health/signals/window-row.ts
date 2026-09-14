import { bindQueryParams, loadQuery } from '@wp/db';
import type { CollectCtx } from './types.js';

/**
 * signals/window-row.ts (P16 Unit B, step 3) - the ONE shared fetch of
 * `db/queries/health-signal-windows.sql`'s single row, reused by all twelve
 * collectors so the query runs exactly once per `collect()` call site rather
 * than once per signal. Not cached across calls (each evaluator tick must
 * see a fresh read) - only the `.sql` file's own parsed/positional form is
 * cached, by `loadQuery` itself.
 */
export interface WindowRow extends Record<string, unknown> {
  disconnect_count_6h: string | number;
  reconnect_churn_count_6h: string | number;
  last_hard_signal_audit_at: Date | null;
  attempted_1h: string | number;
  transient_failed_1h: string | number;
  attempted_24h: string | number;
  rejected_failed_24h: string | number;
  invalid_jid_failed_24h: string | number;
  eligible_sent_24h: string | number;
  delivered_24h: string | number;
  read_24h: string | number;
  sent_24h: string | number;
  opt_outs_24h: string | number;
  new_convs_72h: string | number;
  cold_sent_24h: string | number;
}

/** `count(*)` returns `bigint`, which `pg` decodes as a JS string - this normalizes every counted column back to `number` (safe: no per-tenant per-window count in this table can plausibly exceed `Number.MAX_SAFE_INTEGER`). */
export function toCount(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export async function fetchWindowRow(ctx: CollectCtx): Promise<WindowRow> {
  const query = await loadQuery('health-signal-windows');
  const params = bindQueryParams(query, {
    client_id: ctx.clientId,
    instance_id: ctx.instanceId,
    now: ctx.now(),
  });
  const result = await ctx.sql.query<WindowRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error('fetchWindowRow: health-signal-windows.sql returned zero rows (expected one)');
  }
  return row;
}
