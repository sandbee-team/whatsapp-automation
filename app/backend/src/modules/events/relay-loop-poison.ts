import { realtimeEventSchema } from '@wp/contracts';
import type { OutboxRow } from './coalescer.js';

/**
 * modules/events/relay-loop-poison.ts (P15 C1 FIX F2 / CRIT-3, sibling split
 * of relay-loop.ts for the 300-line cap - not a behavioural boundary, same
 * idiom as `session-worker-discovery-wiring.ts`) - per-row isolation for a
 * malformed `outbox_events` row.
 *
 * BEFORE this fix, `toOutboxRow` called `realtimeEventSchema.parse` (throws)
 * INSIDE the claim transaction with no per-row isolation and
 * `outbox_events.attempts` was never written - one malformed row (e.g. an
 * sse event missing a required field; `assertIdsOnly` only rejects UNKNOWN
 * keys, never MISSING ones) rolled back every tick forever and wedged the
 * fleet-wide relay (`ORDER BY id` claims it first every time, so it is
 * reclaimed and re-fails on every subsequent tick too).
 *
 * FIX: `safeParse` per row. A row that fails to parse is never handed to the
 * coalescer; instead its `attempts` counter is incremented in the SAME
 * transaction. Once `attempts` reaches `POISON_ATTEMPT_CEILING` (5), the row
 * is marked published-as-poisoned (`published_at` set, `suppressed_by = 0` -
 * a documented, auditable quarantine sentinel, never a real winner id since
 * `outbox_events.id` is a bigint IDENTITY starting at 1) and counted via
 * `wp_outbox_poison_total{topic_class}` (the row's own `event_type`, matching
 * the label shape `wp_outbox_dropped_total` already uses - no new label
 * dimension). Below the ceiling, the row is simply left unpublished with its
 * bumped `attempts` count, to be reclaimed and re-tried next tick (this is
 * the ONLY thing that makes eventual quarantine possible - the SAME
 * `ORDER BY id` claim query keeps reclaiming it every tick either way, but
 * once quarantined it no longer matches `published_at IS NULL` at all).
 *
 * Every VALID row in the same tick is unaffected - it is returned in
 * `parsed` and proceeds through coalescing/publishing exactly as before.
 */

export const POISON_ATTEMPT_CEILING = 5;
export const POISON_SUPPRESSED_BY_SENTINEL = '0';

export interface PoisonableRow {
  id: string;
  client_id: string;
  instance_id: string | null;
  event_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  coalesce_key: string | null;
  attempts: number;
}

export interface PoisonMetricsPort {
  incrementPoisoned: (topicClass: string, count: number) => void;
}

export interface SplitPoisonRowsResult {
  /** Rows that parsed cleanly - safe to hand to the coalescer. */
  parsed: OutboxRow[];
  /** Rows below the ceiling - bump `attempts` only, leave unpublished for reclaim. */
  toBumpAttempts: string[];
  /** Rows AT the ceiling this attempt - mark published, `suppressed_by` = the quarantine sentinel. */
  toQuarantine: string[];
}

/**
 * Partitions `rows` (already known to be sse-fanned, non-dropped candidates)
 * into cleanly-parsed rows vs. rows needing an attempts-bump or outright
 * quarantine - pure, no I/O. The caller issues the actual UPDATEs and metric
 * increments (same "pure core, thin DB shell" split every other function in
 * this module follows).
 */
export function splitPoisonRows(
  rows: readonly PoisonableRow[],
  metrics: PoisonMetricsPort,
): SplitPoisonRowsResult {
  const parsed: OutboxRow[] = [];
  const toBumpAttempts: string[] = [];
  const toQuarantine: string[] = [];

  for (const row of rows) {
    const result = realtimeEventSchema.safeParse({ type: row.event_type, ...row.payload });
    if (result.success) {
      parsed.push({
        id: row.id,
        clientId: row.client_id,
        instanceId: row.instance_id,
        coalesceKey: row.coalesce_key,
        event: result.data,
      });
      continue;
    }

    const attemptsAfterThis = row.attempts + 1;
    if (attemptsAfterThis >= POISON_ATTEMPT_CEILING) {
      toQuarantine.push(row.id);
      metrics.incrementPoisoned(row.event_type, 1);
    } else {
      toBumpAttempts.push(row.id);
    }
  }

  return { parsed, toBumpAttempts, toQuarantine };
}
