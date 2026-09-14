import { bindQueryParams, loadQuery, type TenantDb } from '@wp/db';
import { nextCampaignState } from '@wp/domain';
import type { ExpansionBudget } from './expansion-budget.js';
import {
  advanceExpansionCursor,
  bumpExpansionCounters,
  completeExpansion,
  markRenderFailed,
  readCampaignForExpansion,
  readExpansionBatch,
  readInstanceEpoch,
  readInstanceQueueDepth,
  renderRecipient,
  runExpandBatchStatement,
  tryAcquireExpanderLock,
} from './expansion.repo.js';

/**
 * expansion.worker.ts (P23 Unit U4, step 5) - Phase B orchestration. See the
 * dispatch canon for the full per-batch contract: advisory lock first, then
 * the shared fleet-wide token bucket, then queue-depth backpressure, then
 * the keyset read, per-row render, and the ref-first set-based expand
 * statement. `deps.onBatch` is an optional hook (never metrics imported
 * directly here) so a later unit can observe batch outcomes without editing
 * this logic.
 */

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_HOLD_QUEUE_DEPTH = 5_000;
const BUDGET_TOKENS_PER_BATCH = 500;

export type ExpansionBatchResult =
  | { kind: 'batch'; inserted: number; renderFailed: number; maxRecipientId: string }
  | { kind: 'held'; reason: 'queue_depth' | 'budget' | 'expander_busy'; depth?: number }
  | { kind: 'done' };

export interface ExpansionBatchDeps {
  tenantDb: TenantDb;
  budget: ExpansionBudget;
  batchSize?: number;
  holdQueueDepth?: number;
  /** Injectable for tests - defaults to `Date.now`. Only used to compute `onBatch`'s `lagSeconds`. */
  now?: () => number;
  onBatch?: (info: {
    campaignId: string;
    inserted: number;
    renderFailed: number;
    statements: number;
    /** Seconds between the campaign's `snapshot_done_at` and this batch's commit - `undefined` when the campaign has no `snapshot_done_at` yet (should not happen for a campaign in `expanding`, but never assumed). */
    lagSeconds?: number;
  }) => void;
}

/** Runs exactly one Phase B batch for `campaignId`. See module doc for the full held/batch/done contract. */
export async function runExpansionBatch(
  deps: ExpansionBatchDeps,
  input: { campaignId: string; clientId: string },
): Promise<ExpansionBatchResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const holdQueueDepth = deps.holdQueueDepth ?? DEFAULT_HOLD_QUEUE_DEPTH;

  // The fleet-wide token bucket is checked BEFORE touching the DB at all -
  // a held-for-budget batch must never open a transaction.
  if (!deps.budget.tryTake(BUDGET_TOKENS_PER_BATCH)) {
    return { kind: 'held', reason: 'budget' };
  }

  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const locked = await tryAcquireExpanderLock(tx, input.clientId);
    if (!locked) {
      return { kind: 'held', reason: 'expander_busy' };
    }

    const campaign = await readCampaignForExpansion(tx, input.clientId, input.campaignId);
    if (!campaign || campaign.status !== 'expanding') {
      return { kind: 'done' };
    }

    const depth = await readInstanceQueueDepth(
      tx,
      input.clientId,
      campaign.instance_id,
      holdQueueDepth + 1,
    );
    if (depth >= holdQueueDepth) {
      return { kind: 'held', reason: 'queue_depth', depth };
    }

    const sessionEpoch = await readInstanceEpoch(tx, input.clientId, campaign.instance_id);
    if (sessionEpoch === undefined) {
      // No live instance - the campaign cannot expand safely; hold rather
      // than erroring (fail-safe, core invariant 2) so a human can inspect.
      return { kind: 'held', reason: 'expander_busy' };
    }

    const rows = await readExpansionBatch(
      tx,
      input.clientId,
      input.campaignId,
      campaign.expand_cursor_recipient_id,
      batchSize,
    );

    if (rows.length === 0) {
      const done = await completeExpansion(
        tx,
        input.clientId,
        input.campaignId,
        nextCampaignState('expanding', 'expand_done'),
      );
      void done;
      return { kind: 'done' };
    }

    const renderable: Array<{
      recipientId: string;
      recipientJid: string;
      recipientE164: string | null;
      recipientHash: Buffer;
      body: string;
    }> = [];
    const renderFailedIds: string[] = [];

    for (const row of rows) {
      const rendered = renderRecipient(campaign.message.body, row.vars);
      if (!rendered.ok) {
        renderFailedIds.push(row.id);
        continue;
      }
      renderable.push({
        recipientId: row.id,
        recipientJid: row.recipient_jid,
        recipientE164: row.recipient_e164,
        recipientHash: row.recipient_hash,
        body: rendered.text,
      });
    }

    await markRenderFailed(tx, input.clientId, input.campaignId, renderFailedIds);

    const { inserted, stamped } = await runExpandBatchStatement(
      tx,
      {
        clientId: input.clientId,
        instanceId: campaign.instance_id,
        campaignId: input.campaignId,
        sessionEpoch,
        priority: campaign.priority,
        scheduledAt: campaign.scheduled_at,
        payloadKind: 'text',
      },
      renderable,
    );

    const maxRecipientId = rows[rows.length - 1]?.id;
    if (maxRecipientId === undefined) {
      throw new Error('runExpansionBatch: batch had rows but no max recipient id');
    }

    await advanceExpansionCursor(tx, input.clientId, input.campaignId, maxRecipientId);
    await bumpExpansionCounters(tx, input.clientId, input.campaignId, {
      stamped,
      renderFailed: renderFailedIds.length,
    });

    const snapshotDoneAt = campaign.snapshot_done_at;
    const lagSeconds =
      snapshotDoneAt === null
        ? undefined
        : ((deps.now ?? Date.now)() - snapshotDoneAt.getTime()) / 1000;

    deps.onBatch?.({
      campaignId: input.campaignId,
      inserted,
      renderFailed: renderFailedIds.length,
      statements: 1,
      lagSeconds,
    });

    return { kind: 'batch', inserted, renderFailed: renderFailedIds.length, maxRecipientId };
  });
}

/** Drives `runExpansionBatch` to completion (test helper) - stops on `done`, or on `held` (the caller decides whether to retry). */
export async function runExpansionToCompletion(
  deps: ExpansionBatchDeps,
  input: { campaignId: string; clientId: string },
): Promise<ExpansionBatchResult> {
  for (;;) {
    const result = await runExpansionBatch(deps, input);
    if (result.kind !== 'batch') {
      return result;
    }
  }
}

export interface ExpansionSweepDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  budget: ExpansionBudget;
  batchSize?: number;
  holdQueueDepth?: number;
  maxCampaignsPerSweep?: number;
  onBatch?: ExpansionBatchDeps['onBatch'];
}

const DEFAULT_MAX_CAMPAIGNS_PER_SWEEP = 20;

/** Cross-tenant cron entry point: discovers campaigns in `expanding`, runs ONE batch per campaign, each in its own transaction so one client's failure never aborts another's. */
export async function runOneBroadcastExpansionSweep(deps: ExpansionSweepDeps): Promise<void> {
  const query = await loadQuery('broadcast-campaigns-pending');
  const pending = await deps.pool.query<{ id: string; client_id: string }>(
    query.text,
    bindQueryParams(query, {
      status: 'expanding',
      limit: deps.maxCampaignsPerSweep ?? DEFAULT_MAX_CAMPAIGNS_PER_SWEEP,
    }),
  );

  for (const row of pending.rows) {
    try {
      await runExpansionBatch(
        {
          tenantDb: deps.tenantDb,
          budget: deps.budget,
          batchSize: deps.batchSize,
          holdQueueDepth: deps.holdQueueDepth,
          onBatch: deps.onBatch,
        },
        { campaignId: row.id, clientId: row.client_id },
      );
    } catch {
      // A single campaign's batch failure never aborts the rest of this
      // sweep's clients - same shape as runOneContactImportSweep's
      // per-client try/catch. The campaign stays in its current state
      // (never auto-failed by a transient error); the next sweep retries.
    }
  }
}
