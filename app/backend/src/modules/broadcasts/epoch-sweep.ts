import type { TenantDb } from '@wp/db';
import { notify } from '../notifications/index.js';

/**
 * epoch-sweep.ts (P23 Unit U6, step 7) - the epoch-stranding sweep: a
 * `session_epoch` bump (401 logout+relink, badSession 500, 411 mismatch)
 * permanently strands every already-EXPANDED `queued` `message_jobs` row
 * still carrying the OLD epoch, because the claim predicate requires
 * `i.session_epoch = j.session_epoch` - zero claims forever, nothing
 * failed, the campaign (or any plain send) sits at `running`/`queued` with
 * no visible error. This module is the ONE place that moves those rows to
 * `blocked_needs_review` - never deletes, never fails, never re-stamps
 * (core invariant 2/5: fail-safe, pause preserves work). It applies to
 * EVERY queued job of the instance, campaign or not, because the epoch
 * check in `claim-jobs.sql` is not campaign-specific.
 *
 * Each batch is its OWN `tenantDb.withTenant` transaction (never one giant
 * transaction) - `FOR UPDATE SKIP LOCKED` lets a concurrent claim attempt on
 * a DIFFERENT still-current-epoch row proceed unimpeded, and a crash
 * between batches loses at most the in-flight batch's work, not the whole
 * sweep (same resumability shape as the reaper/reconciler sweeps). The loop
 * stops when a batch moves zero rows, or after `maxBatches` as a hard
 * safety bound against ever spinning unboundedly on the same instance in
 * one call (logs and returns rather than looping forever).
 *
 * `restamp.service.ts` is the ONLY exit out of `blocked_needs_review` with
 * `unresolved_reason = 'session_epoch_advanced'` - a human-confirmed
 * re-stamp naming the exact affected count, or the existing cancel route.
 * Never automatic (no cron/worker/flag may call that UPDATE - see that
 * module's own header for the source-scan proof).
 */

export interface EpochSweepDeps {
  tenantDb: TenantDb;
}

export interface RunEpochStrandingSweepInput {
  clientId: string;
  instanceId: string;
  currentEpoch: number;
  batchSize?: number;
}

export interface RunEpochStrandingSweepResult {
  moved: number;
  batches: number;
}

const DEFAULT_BATCH_SIZE = 500;
/** Hard safety bound - never spin forever on one instance in one call. */
const MAX_BATCHES = 1_000;

/** `unresolved_send` (P17 registry) is the closest-fitting mandatory kind for a needs-user-action condition; no new kind is added by this unit. */
const EPOCH_STRANDED_NOTIFY_KIND = 'unresolved_send' as const;

/**
 * Moves every `queued` `message_jobs` row of `(clientId, instanceId)` whose
 * `session_epoch` is strictly less than `currentEpoch` to
 * `blocked_needs_review` (`needs_user_action = true`,
 * `unresolved_reason = 'session_epoch_advanced'`), in batches of
 * `batchSize` (default 500), each its own transaction. Idempotent: a second
 * run against an already-swept instance moves 0 rows (nothing left to
 * match `status = 'queued' AND session_epoch < currentEpoch`). Fires ONE
 * `notify()` (dedupe key derived from `(instanceId, currentEpoch)` - see
 * module header) when `moved > 0`.
 */
export async function runEpochStrandingSweep(
  deps: EpochSweepDeps,
  input: RunEpochStrandingSweepInput,
): Promise<RunEpochStrandingSweepResult> {
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  let moved = 0;
  let batches = 0;

  for (; batches < MAX_BATCHES; batches += 1) {
    const batchMoved = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE message_jobs j SET status = 'blocked_needs_review',
                needs_user_action = true,
                unresolved_reason = 'session_epoch_advanced',
                unresolved_at = now(),
                updated_at = now()
           FROM (
             SELECT id, created_at FROM message_jobs
              WHERE client_id = $1 AND instance_id = $2 AND status = 'queued'
                AND session_epoch < $3
              ORDER BY id
              LIMIT $4
              FOR UPDATE SKIP LOCKED
           ) s
          WHERE j.id = s.id AND j.created_at = s.created_at AND j.status = 'queued'
          -- client_id = $1
         RETURNING j.id`,
        [input.clientId, input.instanceId, input.currentEpoch, batchSize],
      );
      return result.rowCount ?? 0;
    });

    moved += batchMoved;
    if (batchMoved === 0) {
      break;
    }
  }

  if (moved > 0) {
    await deps.tenantDb.withTenant(input.clientId, async (tx) => {
      await notify(tx, {
        clientId: input.clientId,
        instanceId: input.instanceId,
        kind: EPOCH_STRANDED_NOTIFY_KIND,
        transitionId: `epoch_stranded:${input.currentEpoch.toString()}`,
        payload: { instanceId: input.instanceId, sessionEpoch: input.currentEpoch, moved },
        requiresUserAction: true,
      });
    });
  }

  return { moved, batches };
}

/** Minimal cross-tenant pool port this module needs for the gauge recount below - same shape as every other cron sweep's `pool` port. */
export interface EpochGaugePool {
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Fleet-wide recount of `blocked_needs_review` rows carrying
 * `unresolved_reason = 'session_epoch_advanced'` - feeds the
 * `wp_stranded_epoch_jobs` gauge (unlabelled, no client_id/instance_id -
 * `platform/metrics/broadcast-metrics.ts`). Counts only, never per-row
 * tenant data - the same "COUNT-only aggregate crosses no isolation
 * boundary" shape as `fleet-gauges.sql`/`wallet-count-empty-clients`.
 */
export async function countStrandedEpochJobs(pool: EpochGaugePool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM message_jobs
      WHERE status = 'blocked_needs_review' AND unresolved_reason = 'session_epoch_advanced'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
