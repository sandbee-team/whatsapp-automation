import type { TenantDb } from '@wp/db';
import { deliveryEventId, writeDeliveryEvent } from '../../engine/queue/delivery-event.js';
import type { QueueMetricsHandles } from '../../engine/queue/metrics.js';
import { reclassifyReapedFailure } from './reaper-failure-reclassify.js';
import type { ReapedRow, ReapOutcome } from './reaper.js';
import type { RepairedSendSink } from './repaired-send-sink.js';
import type { Rng } from '@wp/domain';

/**
 * reaper-row-effects.ts - split out of `reaper.ts` at the max-lines cap
 * (mechanical extraction, P12 C1 review round): the per-tenant WRITE side
 * effects `runOneReaperSweep` drives for the `acked` repair (`applyRepaired
 * Sent`) and the `failed` re-drive (`applyFailureReclassify`, migration
 * 0029 finding 2), plus their shared `readPublicId` helper. `reaper.ts`
 * keeps the pure classification core and the sweep loop; this module owns
 * everything that actually touches Postgres per-row.
 */

export interface RowEffectsDeps {
  tenantDb: TenantDb;
  metrics: Pick<QueueMetricsHandles, 'reaperRepairsTotal' | 'unresolvedJobsTotal'>;
  sink: Pick<RepairedSendSink, 'onRepairedSent'>;
  /** Migration 0029 (finding 2) - injected RNG for the failure re-drive's `backoff()` call. Never `Math.random()` directly (see `@wp/domain`'s browser-purity contract). */
  rng: Rng;
}

/** Reads `public_id` for the delivery event id - per-tenant (message_job_refs is FORCE RLS), so this runs inside the same `withTenant` transaction as the write it accompanies, never against the cross-tenant sweep. */
export async function readPublicId(
  tx: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  },
  clientId: string,
  jobId: string,
): Promise<string | undefined> {
  const result = await tx.query<{ public_id: string }>(
    `SELECT public_id FROM message_job_refs WHERE client_id = $1 AND message_job_id = $2`,
    [clientId, jobId],
  );
  return result.rows[0]?.public_id;
}

/** The `acked` repair's per-tenant side effects: one delivery event + one sink call. Idempotent - `writeDeliveryEvent`'s deterministic id makes a re-run's event write a no-op, and `send_attempts.id` alone keys the sink call. */
export async function applyRepairedSent(deps: RowEffectsDeps, row: ReapedRow): Promise<void> {
  const attemptId = row.sendAttemptId;
  const attemptNo = row.sendAttemptNo;
  if (!attemptId || attemptNo === null) {
    throw new Error(
      `reaper: attempt_state='acked' but send_attempt_id/send_attempt_no missing for job ${row.messageJobId}`,
    );
  }

  await deps.tenantDb.withTenant(row.clientId, async (tx) => {
    const publicId = await readPublicId(tx, row.clientId, row.messageJobId);
    if (!publicId) {
      return; // no ref row (should not happen in practice) - fail-safe: skip the event, never guess an id.
    }
    await writeDeliveryEvent(tx, {
      clientId: row.clientId,
      instanceId: row.instanceId,
      messageJobId: row.messageJobId,
      messageJobCreatedAt: row.messageJobCreatedAt,
      eventType: 'reconciled',
      providerEventId: deliveryEventId(row.instanceId, publicId, 'reconciled', attemptNo),
    });
  });

  await deps.sink.onRepairedSent(attemptId, row.clientId);
}

/** `ReclassifyOutcome` -> this module's own `ReapOutcome` metric label - keeps `reaper-failure-reclassify.ts` free of any `@wp/server-kit` metric-shape knowledge (it returns a small closed union of its own; this module owns the mapping to the metric). */
const FAILURE_METRIC_BY_RECLASSIFY_OUTCOME = {
  terminal: 'failed_terminal',
  paused: 'failed_paused',
  retry_scheduled: 'failed_retry_scheduled',
} as const satisfies Record<string, ReapOutcome>;

/**
 * The `failed` repair's per-tenant re-drive (migration 0029, finding 2):
 * resolves the job's real `public_id`, then calls `reclassifyReapedFailure`
 * (the REAL `classify()` decision + the real terminal/retry/pause writes)
 * inside the same `withTenant` transaction, per-tenant - never through the
 * cross-tenant definer function. Returns the metric label the caller should
 * record.
 */
export async function applyFailureReclassify(
  deps: RowEffectsDeps,
  row: ReapedRow,
): Promise<ReapOutcome> {
  return deps.tenantDb.withTenant(row.clientId, async (tx) => {
    const publicId = await readPublicId(tx, row.clientId, row.messageJobId);
    if (!publicId) {
      // No ref row (should not happen in practice) - fail-safe: skip the
      // re-drive rather than guess an id for its delivery event. The job
      // stays `needs_reconcile` (visible, never silently retried) for a
      // human/reconciler to pick up.
      return 'needs_reconcile';
    }
    const outcome = await reclassifyReapedFailure(tx, row, publicId, { rng: deps.rng });
    return FAILURE_METRIC_BY_RECLASSIFY_OUTCOME[outcome];
  });
}
