import type { KeyProvider } from '@wp/server-kit/crypto';
import { freezeVars, missingVarSkipReason } from '@wp/domain';
import { bindQueryParams, loadQuery, type TenantDb } from '@wp/db';
import { audienceMatchParams, groupsAudienceMatchParams } from './audience.js';
import { runGroupsSnapshotBatch } from './audience-groups.js';
import {
  BroadcastLimitError,
  audienceOverLimitReason,
  resolveEffectiveMaxBroadcastRecipients,
} from './limits.js';
import {
  advanceSnapshotCursor,
  bumpSnapshotCounters,
  completeSnapshot,
  countAudience,
  failSnapshotForLimit,
  insertRecipientBatch,
  readCampaignForSnapshot,
  readSnapshotBatch,
  recipientJidFor,
  type RecipientInsertRow,
} from './snapshot.repo.js';
import { freezeVarsSource } from './snapshot-vars.js';

/**
 * snapshot.worker.ts (P23 Unit U4, step 4) - Phase A orchestration:
 * `runSnapshotBatch` runs exactly ONE batch (the ceiling check only on the
 * very first call, when `snapshot_cursor_contact_id IS NULL`); `
 * runSnapshotToCompletion` drives it to exhaustion for tests.
 * `runOneBroadcastSnapshotSweep` is the cron entry point: cross-tenant
 * discovery of campaigns in `snapshotting`, one batch per campaign per
 * sweep, each inside its own `tenantDb.withTenant` transaction so one
 * client's failure never aborts another's.
 */

const DEFAULT_BATCH_SIZE = 1_000;

export type SnapshotBatchResult =
  | { kind: 'batch'; inserted: number; skipped: number; cursor: string }
  | { kind: 'done'; audienceCount: number }
  | { kind: 'failed'; reason: string };

export interface SnapshotBatchDeps {
  tenantDb: TenantDb;
  batchSize?: number;
  /** Optional hook (P23 Unit U6) - never metrics imported directly here, same "no restructure" shape as `expansion.worker.ts`'s own `onBatch`. Called once per inserted batch with the pending/skipped counts that batch just wrote. */
  onBatch?: (info: { campaignId: string; pending: number; skipped: number }) => void;
  /** Required only for a `groups` campaign (P24 Unit U6) - the `optout-pepper` KEK provider `hashRecipient(keyProvider, groupRecipientHashInput(jid))` needs at snapshot time. A contacts-only caller never needs to supply it. */
  keyProvider?: KeyProvider;
}

/** Runs exactly one Phase A batch for `campaignId`. See module doc for the ceiling/exhaustion contract. */
export async function runSnapshotBatch(
  deps: SnapshotBatchDeps,
  input: { campaignId: string; clientId: string },
): Promise<SnapshotBatchResult> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  // The ceiling failure must be written and COMMITTED (never rolled back
  // with the throw that reports it) - a thrown error inside `withTenant`'s
  // callback rolls back everything written in that same transaction, so the
  // limit-exceeded write runs to completion here and the caller-facing
  // `BroadcastLimitError` is thrown OUTSIDE, once that commit has landed.
  type LimitFailure = {
    reason: 'no_plan' | 'audience_over_plan_limit';
    count?: number;
    limit?: number;
  };
  let limitFailure: LimitFailure | undefined;

  const result = await deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const campaign = await readCampaignForSnapshot(tx, input.clientId, input.campaignId);
    if (!campaign || campaign.status !== 'snapshotting') {
      // Cancelled/paused/already-advanced meanwhile - a no-op, never an error.
      return { kind: 'done', audienceCount: 0 } as SnapshotBatchResult;
    }

    // A `groups` campaign has no plan-ceiling authority (`max_broadcast_
    // recipients` is a contacts-only admission concern - a client's group
    // count is bounded structurally by `wa_groups`, never by a billing
    // ceiling), so it skips the ceiling-check branch entirely and goes
    // straight to its own batch runner.
    if (campaign.audience.kind === 'groups') {
      if (!deps.keyProvider) {
        throw new Error('runSnapshotBatch: a groups campaign requires deps.keyProvider');
      }
      const { groupIds } = groupsAudienceMatchParams(campaign.audience);
      return runGroupsSnapshotBatch(
        tx,
        deps.keyProvider,
        {
          clientId: input.clientId,
          instanceId: campaign.instance_id,
          campaignId: input.campaignId,
        },
        campaign.snapshot_cursor_contact_id,
        groupIds,
        batchSize,
      );
    }

    const match = audienceMatchParams(campaign.audience);

    if (campaign.snapshot_cursor_contact_id === null) {
      const limit = await resolveEffectiveMaxBroadcastRecipients(tx, input.clientId);
      if (limit === null) {
        await failSnapshotForLimit(tx, input.clientId, input.campaignId, 'no_plan');
        limitFailure = { reason: 'no_plan' };
        return { kind: 'failed', reason: 'no_plan' } as SnapshotBatchResult;
      }
      const count = await countAudience(tx, input.clientId, match);
      if (count > limit) {
        const reason = audienceOverLimitReason(count, limit);
        await failSnapshotForLimit(tx, input.clientId, input.campaignId, reason);
        limitFailure = { reason: 'audience_over_plan_limit', count, limit };
        return { kind: 'failed', reason } as SnapshotBatchResult;
      }
    }

    const rows = await readSnapshotBatch(tx, {
      clientId: input.clientId,
      cursorContactId: campaign.snapshot_cursor_contact_id,
      match,
      batchSize,
    });

    if (rows.length === 0) {
      const result = await completeSnapshot(tx, input.clientId, input.campaignId, 'expanding');
      return { kind: 'done', audienceCount: result.audienceCount } as SnapshotBatchResult;
    }

    const insertRows: RecipientInsertRow[] = rows.map((row) => {
      if (row.is_opted_out) {
        return {
          contactId: row.contact_id,
          recipientJid: recipientJidFor(row.wa_jid),
          recipientE164: row.phone_e164,
          recipientHash: row.phone_hash,
          status: 'skipped',
          skipReason: 'opted_out',
          vars: {},
        };
      }
      const frozen = freezeVars(campaign.message.body, freezeVarsSource(row));
      if (!frozen.ok) {
        return {
          contactId: row.contact_id,
          recipientJid: recipientJidFor(row.wa_jid),
          recipientE164: row.phone_e164,
          recipientHash: row.phone_hash,
          status: 'skipped',
          skipReason: missingVarSkipReason(frozen.missingToken),
          vars: {},
        };
      }
      return {
        contactId: row.contact_id,
        recipientJid: recipientJidFor(row.wa_jid),
        recipientE164: row.phone_e164,
        recipientHash: row.phone_hash,
        status: 'pending',
        skipReason: null,
        vars: frozen.vars,
      };
    });

    const inserted = await insertRecipientBatch(tx, input.clientId, input.campaignId, insertRows);
    const maxContactId = rows[rows.length - 1]?.contact_id;
    if (maxContactId === undefined) {
      throw new Error('runSnapshotBatch: batch had rows but no max contact id');
    }

    await advanceSnapshotCursor(tx, input.clientId, input.campaignId, maxContactId);
    await bumpSnapshotCounters(tx, input.clientId, input.campaignId, {
      total: inserted.insertedCount,
      pending: inserted.pendingCount,
      skipped: inserted.skippedCount,
    });
    deps.onBatch?.({
      campaignId: input.campaignId,
      pending: inserted.pendingCount,
      skipped: inserted.skippedCount,
    });

    if (rows.length < batchSize) {
      const result = await completeSnapshot(tx, input.clientId, input.campaignId, 'expanding');
      return { kind: 'done', audienceCount: result.audienceCount } as SnapshotBatchResult;
    }

    return {
      kind: 'batch',
      inserted: inserted.pendingCount,
      skipped: inserted.skippedCount,
      cursor: maxContactId,
    } as SnapshotBatchResult;
  });

  if (limitFailure) {
    throw new BroadcastLimitError(limitFailure.reason, limitFailure.count, limitFailure.limit);
  }
  return result;
}

/** Drives `runSnapshotBatch` to completion (test helper) - stops on `done` or `failed`. */
export async function runSnapshotToCompletion(
  deps: SnapshotBatchDeps,
  input: { campaignId: string; clientId: string },
): Promise<SnapshotBatchResult> {
  for (;;) {
    const result = await runSnapshotBatch(deps, input);
    if (result.kind !== 'batch') {
      return result;
    }
  }
}

export interface SnapshotSweepDeps {
  pool: {
    query<T extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }>;
  };
  tenantDb: TenantDb;
  batchSize?: number;
  maxCampaignsPerSweep?: number;
  onBatch?: SnapshotBatchDeps['onBatch'];
}

const DEFAULT_MAX_CAMPAIGNS_PER_SWEEP = 20;

/** Cross-tenant cron entry point: discovers campaigns in `snapshotting`, runs ONE batch per campaign, each in its own transaction so one client's failure never aborts another's. */
export async function runOneBroadcastSnapshotSweep(deps: SnapshotSweepDeps): Promise<void> {
  const query = await loadQuery('broadcast-campaigns-pending');
  const pending = await deps.pool.query<{ id: string; client_id: string }>(
    query.text,
    bindQueryParams(query, {
      status: 'snapshotting',
      limit: deps.maxCampaignsPerSweep ?? DEFAULT_MAX_CAMPAIGNS_PER_SWEEP,
    }),
  );

  for (const row of pending.rows) {
    try {
      await runSnapshotBatch(
        { tenantDb: deps.tenantDb, batchSize: deps.batchSize, onBatch: deps.onBatch },
        { campaignId: row.id, clientId: row.client_id },
      );
    } catch {
      // A BroadcastLimitError (or any other batch failure) has already been
      // recorded onto the campaign row itself (failSnapshotForLimit) inside
      // runSnapshotBatch's own transaction, or is a transient DB error the
      // next sweep will retry - never let one campaign's failure abort the
      // rest of this sweep's clients (same shape as
      // runOneContactImportSweep's per-client try/catch).
    }
  }
}
