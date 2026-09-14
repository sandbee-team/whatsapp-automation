import { loadQuery, bindQueryParams, type TenantDb } from '@wp/db';
import type { Rng } from '@wp/domain';
import type { QueueMetricsHandles } from '../../engine/queue/metrics.js';
import { applyFailureReclassify, applyRepairedSent } from './reaper-row-effects.js';
import type { RepairedSendSink } from './repaired-send-sink.js';

/**
 * reaper.ts (P12 Unit U2, step 3) - the DB-driving wrapper around
 * `wp_reap_expired_leases` (migration 0027, SECURITY DEFINER, owned by the
 * NOLOGIN/BYPASSRLS `wp_reaper` role): re-drives every `processing`
 * message_jobs row whose lease expired more than `TIMING.reaperGraceMs` ago,
 * one cross-tenant pass. The SQL function alone owns the state machine
 * (no-attempt/prepared -> requeue, dispatched -> needs_reconcile, acked ->
 * sent, failed -> requeue) - this module's job is purely to classify each
 * RETURNING row into the right metric/side-effect (`classifyReapedRow`, pure,
 * unit-tested in `reaper.test.ts`) and drive the two per-tenant writes that
 * the definer function cannot itself perform (a delivery event, and the
 * money-seam sink call) through the normal `tenantDb.withTenant` RLS path.
 *
 * **Never requeues an `acked` attempt** (core invariant 2, `result.ts`'s own
 * module header): the SQL function's CASE never maps `acked` to `queued`,
 * and this module adds no override on top of it - a crash-window `acked`
 * attempt is repaired to `sent`, exactly once, from the attempt row.
 *
 * The cross-tenant SWEEP (`reap-expired-leases.sql`) is the only part of
 * this module that runs outside `withTenant` - it is a bounded, ordered
 * `SELECT` through the definer function, not a raw table scan. Every WRITE
 * this module makes on top of that (delivery event, sink call) is per-tenant,
 * scoped via `deps.tenantDb.withTenant(row.clientId, ...)`.
 */

export interface ReapedRow {
  clientId: string;
  instanceId: string;
  messageJobId: string;
  messageJobCreatedAt: Date;
  newStatus: string;
  attemptState: string | null;
  sendAttemptId: string | null;
  sendAttemptNo: number | null;
  /** Migration 0029 (P12 C1 review, finding 2) - the attempt's error class, present only alongside `attemptState === 'failed'`. */
  errorClass: string | null;
  /** Migration 0029 (P12 C1 review, finding 2) - `message_jobs.max_attempts`, needed for the failure re-drive's exhaustion arithmetic. */
  maxAttempts: number | null;
}

/**
 * Closed union of `wp_reaper_repairs_total{result}` label values - truthful
 * to exactly what this module emits, one per contract row (P11's fixtured
 * crash states). Label name is `result`, not `outcome` - see `metrics.ts`'s
 * own header for why.
 *
 * Migration 0029 (P12 C1 review, finding 2) REMOVES `requeued_failed`: the
 * SQL no longer decides a `failed` attempt's disposition unconditionally
 * (it moves to `needs_reconcile` like `dispatched`, then this module
 * re-drives it through the REAL `classify()` decision) - so a `failed`
 * repair now emits exactly one of the three NEW labels below, matching
 * `reclassifyReapedFailure`'s `ReclassifyOutcome` union 1:1.
 */
export const REAP_OUTCOMES = [
  'requeued_no_attempt',
  'requeued_prepared',
  'needs_reconcile',
  'repaired_sent',
  'failed_terminal',
  'failed_paused',
  'failed_retry_scheduled',
] as const;
export type ReapOutcome = (typeof REAP_OUTCOMES)[number];

export interface ReapedRowClassification {
  /**
   * `null` for exactly one case (`attemptState === 'failed'`) - migration
   * 0029 (finding 2) means this row's final disposition is NOT decidable
   * without an async re-drive through the real `classify()` (`requires
   * FailureReclassify` below), so this PURE function cannot name a final
   * metric label for it up front. Every other branch still resolves a label
   * synchronously, unchanged.
   */
  metricOutcome: ReapOutcome | null;
  /** Whether this row owes exactly one `delivery_events(event_type='reconciled')` write. */
  emitDeliveryEvent: boolean;
  /** Whether this row owes exactly one `RepairedSendSink.onRepairedSent(attemptId)` call (the money seam). */
  repairsSend: boolean;
  /** Whether this row owes a `wp_unresolved_jobs_total` increment (moved to needs_reconcile, pending human/reconciler resolution). */
  marksUnresolved: boolean;
  /** Migration 0029 (finding 2) - whether this row owes an async re-drive through `reclassifyReapedFailure` (real `classify()`, real terminal/retry/pause writes) before its metric label is known. */
  requiresFailureReclassify: boolean;
}

/**
 * Pure: classifies one `wp_reap_expired_leases` RETURNING row into its
 * metric label + side effects. No I/O - see this module's own header for why
 * the DB-driving half is proved by the integration suite instead.
 */
export function classifyReapedRow(row: ReapedRow): ReapedRowClassification {
  if (row.attemptState === 'acked') {
    return {
      metricOutcome: 'repaired_sent',
      emitDeliveryEvent: true,
      repairsSend: true,
      marksUnresolved: false,
      requiresFailureReclassify: false,
    };
  }

  if (row.attemptState === 'dispatched') {
    return {
      metricOutcome: 'needs_reconcile',
      emitDeliveryEvent: false,
      repairsSend: false,
      marksUnresolved: true,
      requiresFailureReclassify: false,
    };
  }

  if (row.attemptState === 'failed') {
    // Migration 0029 (finding 2): the SQL no longer decides this row's
    // disposition - `runOneReaperSweep` calls `reclassifyReapedFailure` and
    // fills in the real metric label from its return value. No delivery
    // event/sink call/unresolved-metric owed HERE (the reclassify path
    // writes its own delivery event per outcome).
    return {
      metricOutcome: null,
      emitDeliveryEvent: false,
      repairsSend: false,
      marksUnresolved: false,
      requiresFailureReclassify: true,
    };
  }

  if (row.attemptState === 'prepared') {
    return {
      metricOutcome: 'requeued_prepared',
      emitDeliveryEvent: false,
      repairsSend: false,
      marksUnresolved: false,
      requiresFailureReclassify: false,
    };
  }

  // row.attemptState === null - no attempt row was ever recorded.
  return {
    metricOutcome: 'requeued_no_attempt',
    emitDeliveryEvent: false,
    repairsSend: false,
    marksUnresolved: false,
    requiresFailureReclassify: false,
  };
}

interface ScanRow extends Record<string, unknown> {
  client_id: string;
  instance_id: string;
  message_job_id: string;
  message_job_created_at: Date;
  new_status: string;
  attempt_state: string | null;
  send_attempt_id: string | null;
  send_attempt_no: number | null;
  error_class: string | null;
  max_attempts: number | null;
}

function toReapedRow(row: ScanRow): ReapedRow {
  return {
    clientId: row.client_id,
    instanceId: row.instance_id,
    messageJobId: row.message_job_id,
    messageJobCreatedAt: row.message_job_created_at,
    newStatus: row.new_status,
    attemptState: row.attempt_state,
    sendAttemptId: row.send_attempt_id,
    sendAttemptNo: row.send_attempt_no,
    errorClass: row.error_class,
    maxAttempts: row.max_attempts,
  };
}

export interface ReaperDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  metrics: Pick<QueueMetricsHandles, 'reaperRepairsTotal' | 'unresolvedJobsTotal'>;
  sink: Pick<RepairedSendSink, 'onRepairedSent'>;
  graceSeconds: number;
  /** Bounded batch size for the cross-tenant sweep - never unbounded. */
  limit: number;
  /** Migration 0029 (finding 2) - injected RNG for the failure re-drive's `backoff()` call. Never `Math.random()` directly (see `@wp/domain`'s browser-purity contract). */
  rng: Rng;
}

/**
 * Runs one reaper sweep: the cross-tenant lease-expiry scan (bounded by
 * `deps.limit`), then classifies + drives per-tenant side effects for each
 * repaired row. Zero repairs is a normal outcome.
 */
export async function runOneReaperSweep(deps: ReaperDeps): Promise<void> {
  const query = await loadQuery('reap-expired-leases');
  const params = bindQueryParams(query, {
    grace_seconds: deps.graceSeconds,
    limit: deps.limit,
  });
  const scan = await deps.pool.query<ScanRow>(query.text, params);

  for (const scanRow of scan.rows) {
    const row = toReapedRow(scanRow);
    const classification = classifyReapedRow(row);

    if (classification.requiresFailureReclassify) {
      const metricOutcome = await applyFailureReclassify(deps, row);
      deps.metrics.reaperRepairsTotal.inc({ result: metricOutcome });
      continue;
    }

    // Every other branch resolves its label synchronously - see
    // classifyReapedRow's own doc for why only 'failed' is null here.
    const metricOutcome = classification.metricOutcome;
    if (metricOutcome === null) {
      throw new Error(
        `reaper: classifyReapedRow returned a null metricOutcome without requiresFailureReclassify for job ${row.messageJobId}`,
      );
    }
    deps.metrics.reaperRepairsTotal.inc({ result: metricOutcome });
    if (classification.marksUnresolved) {
      deps.metrics.unresolvedJobsTotal.inc();
    }
    if (classification.repairsSend) {
      await applyRepairedSent(deps, row);
    }
  }
}
