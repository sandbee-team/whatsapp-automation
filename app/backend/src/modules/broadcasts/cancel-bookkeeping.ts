import { logger } from '@wp/server-kit';
import { bindQueryParams, loadQuery, type TenantDb, type TenantQueryable } from '@wp/db';

/**
 * cancel-bookkeeping.ts (P23 Unit U5, step 6; P23 C1 fix round unit F1) - the
 * RESUMABLE stamping sweep that runs AFTER a broadcast's `cancelled` status
 * commit. It is explicitly NOT the enforcement point (the claim predicate's
 * allow-list is - see `db/queries/claim-jobs.sql`'s own header and this
 * phase's canon): this sweep only makes the already-stopped campaign's rows
 * (and its `campaign_counters` rollup) visibly consistent.
 *
 * Batches of `batchSize` (default 500), each its OWN transaction, so a crash
 * between batches leaves the cancel fully enforced (the predicate) and the
 * next sweep call simply finishes stamping - never a half-done state.
 * `message_jobs`' PK is `(id, created_at)`; every batch binds both.
 */

export interface CancelBookkeepingResult {
  recipientsStamped: number;
  jobsStamped: number;
  done: boolean;
}

export interface CancelBookkeepingBatchDeps {
  /** Optional hook (P23 Unit U6b) - never metrics imported directly here, same "no restructure" shape as `snapshot.worker.ts`/`expansion.worker.ts`'s own `onBatch`. Called once per call to `runCancelBookkeepingBatch` with the total recipients stamped `cancelled` across all its internal batches. */
  onBatch?: (info: { campaignId: string; cancelledRecipients: number }) => void;
}

interface RecipientStampCounts {
  fromPending: number;
  fromQueued: number;
}

/** Cheap existence probe - `true` iff at least one non-terminal `campaign_recipients` row remains for this campaign. A plain SELECT, never an UPDATE, so a finished campaign's resumed sweep issues zero UPDATE statements (proven by `running_the_sweep_twice_on_a_finished_campaign_does_zero_updates_the_second_time`). */
async function hasPendingRecipients(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<boolean> {
  const result = await tx.query<{ found: number }>(
    `SELECT 1 AS found FROM campaign_recipients
      WHERE campaign_id = $1 AND client_id = $2 AND status IN ('pending', 'queued')
      -- client_id = $2
      LIMIT 1`,
    [campaignId, clientId],
  );
  return result.rows.length > 0;
}

/**
 * Stamps up to `batchSize` non-terminal `campaign_recipients` rows
 * `cancelled` in ONE statement - a data-modifying CTE selects the batch
 * (capturing each row's PRIOR status before the UPDATE touches it) so the
 * exact per-status counts are known without a second round trip, clamping
 * or guessing: `campaign_counters` is adjusted from these same counts in the
 * SAME transaction, immediately below. Callers must only invoke this after
 * `hasPendingRecipients` confirms there is work - never called speculatively.
 */
async function stampRecipientBatch(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  batchSize: number,
): Promise<RecipientStampCounts> {
  const result = await tx.query<{ status: 'pending' | 'queued' }>(
    `WITH batch AS (
       SELECT id, status FROM campaign_recipients
        WHERE campaign_id = $1 AND client_id = $2 AND status IN ('pending', 'queued')
        -- client_id = $2
        ORDER BY id
        LIMIT $3
     )
     UPDATE campaign_recipients r SET status = 'cancelled', terminal_at = now()
       FROM batch
      WHERE r.id = batch.id
     RETURNING batch.status`,
    [campaignId, clientId, batchSize],
  );

  let fromPending = 0;
  let fromQueued = 0;
  for (const row of result.rows) {
    if (row.status === 'pending') fromPending += 1;
    else fromQueued += 1;
  }
  return { fromPending, fromQueued };
}

/**
 * Adjusts `campaign_counters` by the exact per-status deltas a single
 * `stampRecipientBatch` call just stamped `cancelled` - one aggregate
 * UPDATE, never a per-row write. A delta is never allowed to drive a
 * counter negative (a defensive floor, not an expected path: it would mean
 * the counters row was already inconsistent with the recipient rows before
 * this batch ran) - `GREATEST(col - delta, 0)` floors at 0 and the event is
 * logged ids-only so it is visible without ever aborting the sweep.
 */
async function adjustCountersForCancel(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
  counts: RecipientStampCounts,
): Promise<void> {
  const totalStamped = counts.fromPending + counts.fromQueued;
  if (totalStamped === 0) return;

  const result = await tx.query<{ pending: number; queued: number }>(
    `UPDATE campaign_counters SET pending = GREATEST(pending - $3, 0),
            queued = GREATEST(queued - $4, 0),
            cancelled = cancelled + $5,
            updated_at = now()
      WHERE campaign_id = $1 AND client_id = $2
      -- client_id = $2
     RETURNING pending, queued`,
    [campaignId, clientId, counts.fromPending, counts.fromQueued, totalStamped],
  );

  const row = result.rows[0];
  if (row && (row.pending < 0 || row.queued < 0)) {
    // campaign_id is not in LogFields' allow-list (reconciler.ts's own
    // constraint) - it goes in the free-text message, never a struct field.
    logger.warn(
      { client_id: clientId },
      `cancel-bookkeeping: campaign_counters floored at 0 for campaign ${campaignId} (pending/queued delta exceeded the stored count)`,
    );
  }
}

interface CampaignInstanceRow extends Record<string, unknown> {
  instance_id: string;
}

/** Reads `campaigns.instance_id` once per `runCancelBookkeepingBatch` call - campaign jobs always carry the campaign's own `instance_id`, so binding it lets `stampJobBatch`'s SELECT probe `message_jobs_claim_idx (client_id, instance_id, ...)` instead of scanning the client's whole queued backlog. */
async function readCampaignInstanceId(
  tx: TenantQueryable,
  clientId: string,
  campaignId: string,
): Promise<string | undefined> {
  const result = await tx.query<CampaignInstanceRow>(
    `SELECT instance_id FROM campaigns WHERE id = $1 AND client_id = $2 -- client_id = $2`,
    [campaignId, clientId],
  );
  return result.rows[0]?.instance_id;
}

interface JobBatchRow extends Record<string, unknown> {
  id: string;
  created_at: Date;
}

/** Cheap existence probe - `true` iff at least one `queued` `message_jobs` row remains for this campaign. A plain SELECT, never an UPDATE - same "check before you write" idiom as `hasPendingRecipients`. */
async function hasQueuedJobs(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  campaignId: string,
): Promise<boolean> {
  const result = await tx.query<{ found: number }>(
    `SELECT 1 AS found FROM message_jobs
      WHERE client_id = $1 AND instance_id = $2 AND campaign_id = $3 AND status = 'queued'
      -- client_id = $1
      LIMIT 1`,
    [clientId, instanceId, campaignId],
  );
  return result.rows.length > 0;
}

/** Stamps up to `batchSize` `queued` `message_jobs` rows `cancelled` for this campaign - conditional `WHERE status = 'queued'`, `instance_id` bound so the SELECT probes `message_jobs_claim_idx` instead of scanning the client's whole queued backlog, never `failed`, never a DELETE, `attempts` untouched. Callers must only invoke this after `hasQueuedJobs` confirms there is work. */
async function stampJobBatch(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  campaignId: string,
  batchSize: number,
): Promise<number> {
  const result = await tx.query<JobBatchRow>(
    `UPDATE message_jobs SET status = 'cancelled', cancel_reason = 'campaign_cancelled',
            terminal_at = now(), updated_at = now()
      WHERE (id, created_at) IN (
        SELECT id, created_at FROM message_jobs
         WHERE client_id = $1 AND instance_id = $2 AND campaign_id = $3 AND status = 'queued'
         -- client_id = $1
         ORDER BY id
         LIMIT $4
      )
     RETURNING id, created_at`,
    [clientId, instanceId, campaignId, batchSize],
  );
  return result.rowCount ?? result.rows.length;
}

/**
 * Runs ONE resumable cancel-bookkeeping pass for `campaignId`: batches of
 * `batchSize` recipients (each batch's `campaign_counters` delta applied in
 * the SAME transaction), then `batchSize` jobs, each its own transaction,
 * repeated until both are exhausted for this call. `done: true` means both
 * a recipient batch and a job batch came back empty on the SAME call - the
 * cron sweep (`cron-wiring-broadcasts.ts`) simply calls this again on its
 * next tick for any campaign still not `done`.
 */
export async function runCancelBookkeepingBatch(
  tx: { withTenant: <T>(clientId: string, fn: (tx: TenantQueryable) => Promise<T>) => Promise<T> },
  input: { clientId: string; campaignId: string; batchSize?: number },
  deps: CancelBookkeepingBatchDeps = {},
): Promise<CancelBookkeepingResult> {
  const batchSize = input.batchSize ?? 500;
  let recipientsStamped = 0;
  let jobsStamped = 0;

  for (;;) {
    const count = await tx.withTenant(input.clientId, async (t) => {
      if (!(await hasPendingRecipients(t, input.clientId, input.campaignId))) return 0;
      const stamped = await stampRecipientBatch(t, input.clientId, input.campaignId, batchSize);
      await adjustCountersForCancel(t, input.clientId, input.campaignId, stamped);
      return stamped.fromPending + stamped.fromQueued;
    });
    recipientsStamped += count;
    if (count < batchSize) break;
  }

  const instanceId = await tx.withTenant(input.clientId, (t) =>
    readCampaignInstanceId(t, input.clientId, input.campaignId),
  );

  if (instanceId !== undefined) {
    for (;;) {
      const count = await tx.withTenant(input.clientId, async (t) => {
        if (!(await hasQueuedJobs(t, input.clientId, instanceId, input.campaignId))) return 0;
        return stampJobBatch(t, input.clientId, instanceId, input.campaignId, batchSize);
      });
      jobsStamped += count;
      if (count < batchSize) break;
    }
  }

  deps.onBatch?.({ campaignId: input.campaignId, cancelledRecipients: recipientsStamped });

  return { recipientsStamped, jobsStamped, done: true };
}

export interface CancelBookkeepingSweepDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  batchSize?: number;
  maxCampaignsPerSweep?: number;
  onBatch?: CancelBookkeepingBatchDeps['onBatch'];
  /** Injectable for tests - defaults to `@wp/server-kit`'s `logger`. */
  logger?: { warn: (meta: Record<string, unknown>, message: string) => void };
}

const DEFAULT_MAX_CAMPAIGNS_PER_SWEEP = 20;

/**
 * Cross-tenant cron entry point (`cron-wiring-broadcasts.ts`'s third loop):
 * discovers `cancelled` campaigns that STILL have bookkeeping work left
 * (`broadcast-cancel-bookkeeping-pending.sql` - bounded, EXISTS-gated on
 * either side so a fully-stamped campaign is never re-picked and a
 * later-cancelled campaign with real work is never starved), runs ONE
 * bookkeeping pass per campaign, each wrapped in its own try/catch so one
 * client's failure never aborts the rest of this sweep's clients (same
 * shape as `runOneBroadcastSnapshotSweep`) - logged ids-only, never
 * rethrown, same idiom as `store-purge.ts`'s `onEpochAdvanced` hook.
 */
export async function runOneCancelBookkeepingSweep(
  deps: CancelBookkeepingSweepDeps,
): Promise<void> {
  const query = await loadQuery('broadcast-cancel-bookkeeping-pending');
  const pending = await deps.pool.query<{ id: string; client_id: string }>(
    query.text,
    bindQueryParams(query, {
      limit: deps.maxCampaignsPerSweep ?? DEFAULT_MAX_CAMPAIGNS_PER_SWEEP,
    }),
  );

  const log = deps.logger ?? logger;
  for (const row of pending.rows) {
    try {
      await runCancelBookkeepingBatch(
        deps.tenantDb,
        { clientId: row.client_id, campaignId: row.id, batchSize: deps.batchSize },
        { onBatch: deps.onBatch },
      );
    } catch (err) {
      const name = err instanceof Error ? err.name : 'Error';
      // `campaign_id` is not in @wp/server-kit's LogFields allow-list (same
      // constraint reconciler.ts's own logger.warn call works around) - the
      // id goes in the free-text message, never a structured field/PII.
      log.warn(
        { client_id: row.client_id },
        `cancel-bookkeeping: sweep failed for campaign ${row.id} (never aborts the rest of the sweep): ${name}`,
      );
    }
  }
}
