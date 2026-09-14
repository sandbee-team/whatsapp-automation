import {
  BROADCAST_DISCLOSURE,
  BROADCAST_ESTIMATE_CAVEAT,
  BROADCAST_FREQUENCY_NOTE,
  freezeVars,
  missingVarSkipReason,
  resolvePriceKey,
} from '@wp/domain';
import type { BroadcastPreflight, BroadcastPreflightSkipReason } from '@wp/contracts';
import { broadcastPreflightSchema, BROADCAST_PREFLIGHT_OPTIONS } from '@wp/contracts';
import { resolveRateMinor } from '../wallet/index.js';
import { audienceMatchParams, type ContactsAudienceJson } from './audience.js';
import {
  BroadcastNotFoundError,
  InstanceNotFoundError,
  PreflightAudienceOverLimitError,
  PreflightNoPlanError,
  PreflightNotAllowedError,
} from './broadcasts.errors.js';
import type { LifecycleDeps } from './lifecycle-detail.js';
import { assertUserActor, type BroadcastActor } from './lifecycle.service.js';
import { findInstanceForClient, readCampaign } from './broadcasts.repo.js';
import { resolveEffectiveMaxBroadcastRecipients } from './limits.js';
import { buildGroupsPreflightQuote } from './preflight-groups.js';
import {
  countPreflightFrequencyDeferrals,
  readPreflightInstanceThresholds,
  readPreflightSentToday,
  readPreflightWalletBalance,
  stampPreflightQuote,
} from './preflight.repo.js';
import { freezeVarsSource } from './snapshot-vars.js';
import { countAudience, readCampaignForSnapshot, readSnapshotBatch } from './snapshot.repo.js';

/**
 * preflight.service.ts (P23a Unit U1a, step 2; groups branch P24 Unit U6) -
 * `preflightBroadcast`: the pre-flight quote for a `draft`/`scheduled`
 * broadcast. Walks the SAME audience predicate/rows the snapshot worker
 * will, adds the client-level frequency-deferral count, stamps `campaigns.
 * quote_minor`/`price_key` conditionally. A `groups` campaign delegates its
 * ENTIRE quote to `preflight-groups.ts#buildGroupsPreflightQuote`.
 */

const SNAPSHOT_BATCH_SIZE = 1_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ComputeEstimateInput {
  billable: number;
  effDailyCap: number;
  sentToday: number;
  now: Date;
}

export interface EstimateResult {
  totalDays: number | null;
  finishAt: string | null;
  remainingToday: number;
  /** ALWAYS the fixed two-lever set - see `BROADCAST_PREFLIGHT_OPTIONS`'s own doc comment (never a third option, never a "faster"/"boost" mode - it does not exist). */
  options: readonly ['reduce_audience', 'wait_for_warm_up'];
}

/** Cap-derived finish estimate - see this module's own header for the four cases (zero billable / zero cap / fits today / spills over multiple days). */
export function computeEstimate(input: ComputeEstimateInput): EstimateResult {
  const remainingToday = Math.max(input.effDailyCap - input.sentToday, 0);
  const options = BROADCAST_PREFLIGHT_OPTIONS;

  if (input.billable === 0) {
    return { totalDays: 0, finishAt: input.now.toISOString(), remainingToday, options };
  }
  if (input.effDailyCap <= 0) {
    return { totalDays: null, finishAt: null, remainingToday, options };
  }
  if (input.billable <= remainingToday) {
    return { totalDays: 1, finishAt: input.now.toISOString(), remainingToday, options };
  }

  const totalDays = 1 + Math.ceil((input.billable - remainingToday) / input.effDailyCap);
  const finishAt = new Date(input.now.getTime() + (totalDays - 1) * MS_PER_DAY).toISOString();
  return { totalDays, finishAt, remainingToday, options };
}

/** Integer paise product - throws if the result would not be a safe integer (never a silent float). */
export function computeQuoteMinor(count: number, rateMinor: number): number {
  const quoteMinor = count * rateMinor;
  if (!Number.isSafeInteger(quoteMinor)) {
    throw new Error(
      `computeQuoteMinor: ${String(count)} * ${String(rateMinor)} is not a safe integer`,
    );
  }
  return quoteMinor;
}

export interface ComputeBillableInput {
  matched: number;
  skipReasons: BroadcastPreflightSkipReason[];
  deferred: number;
}

export interface BillableResult {
  skipped: number;
  sendable: number;
  billable: number;
}

/** `sendable = matched - skipped`; `billable = sendable - deferred` (client-level frequency deferrals). */
export function computeBillable(input: ComputeBillableInput): BillableResult {
  const skipped = input.skipReasons.reduce((sum, r) => sum + r.count, 0);
  const sendable = input.matched - skipped;
  const billable = sendable - input.deferred;
  return { skipped, sendable, billable };
}

interface WalkedAudience {
  skipped: number;
  skipReasons: BroadcastPreflightSkipReason[];
  sendableHashes: Buffer[];
}

/** Walks the full audience via `readSnapshotBatch`, mirroring `snapshot.worker.ts`'s skip precedence EXACTLY: opted-out first, then a missing frozen var, else sendable. Caller must have already excluded `audience.kind === 'groups'`. */
async function walkPreflightAudience(
  tx: Parameters<typeof readSnapshotBatch>[0],
  clientId: string,
  campaign: (Awaited<ReturnType<typeof readCampaignForSnapshot>> & object) & {
    audience: ContactsAudienceJson;
  },
): Promise<WalkedAudience> {
  const match = audienceMatchParams(campaign.audience);
  const skipCounts = new Map<string, number>();
  const skipOrder: string[] = [];
  const sendableHashes: Buffer[] = [];
  let cursor: string | null = null;

  for (;;) {
    const rows = await readSnapshotBatch(tx, {
      clientId,
      cursorContactId: cursor,
      match,
      batchSize: SNAPSHOT_BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      let reason: string | null = null;
      if (row.is_opted_out) {
        reason = 'opted_out';
      } else {
        const frozen = freezeVars(campaign.message.body, freezeVarsSource(row));
        if (!frozen.ok) {
          reason = missingVarSkipReason(frozen.missingToken);
        }
      }
      if (reason === null) {
        sendableHashes.push(row.phone_hash);
      } else {
        if (!skipCounts.has(reason)) skipOrder.push(reason);
        skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
      }
    }

    cursor = rows[rows.length - 1]!.contact_id;
    if (rows.length < SNAPSHOT_BATCH_SIZE) break;
  }

  const skipReasons = skipOrder.map((reason) => ({ reason, count: skipCounts.get(reason)! }));
  const skipped = skipReasons.reduce((sum, r) => sum + r.count, 0);
  return { skipped, skipReasons, sendableHashes };
}

/** Runs `countPreflightFrequencyDeferrals` in batches over `hashes` (never one unbounded IN-list) - sums the per-batch deferred counts. */
async function countDeferralsInBatches(
  tx: Parameters<typeof countPreflightFrequencyDeferrals>[0],
  clientId: string,
  hashes: Buffer[],
  limits: { perRecipient24h: number; perRecipient7d: number },
): Promise<number> {
  let deferred = 0;
  for (let i = 0; i < hashes.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = hashes.slice(i, i + SNAPSHOT_BATCH_SIZE);
    deferred += await countPreflightFrequencyDeferrals(tx, clientId, batch, limits);
  }
  return deferred;
}

export interface PreflightBroadcastInput {
  clientId: string;
  id: string;
}

export async function preflightBroadcast(
  deps: LifecycleDeps,
  actor: BroadcastActor,
  input: PreflightBroadcastInput,
): Promise<BroadcastPreflight> {
  assertUserActor(actor);
  return deps.tenantDb.withTenant(input.clientId, async (tx) => {
    const summary = await readCampaign(tx, input.clientId, input.id);
    if (!summary) throw new BroadcastNotFoundError();
    if (summary.status !== 'draft' && summary.status !== 'scheduled') {
      throw new PreflightNotAllowedError(input.id);
    }

    const campaign = await readCampaignForSnapshot(tx, input.clientId, input.id);
    if (!campaign) throw new BroadcastNotFoundError();
    const instanceId = summary.instance_id;
    const instance = await findInstanceForClient(tx, input.clientId, instanceId);
    if (!instance) throw new InstanceNotFoundError();
    const thresholds = await readPreflightInstanceThresholds(tx, input.clientId, instanceId);
    if (!thresholds) throw new InstanceNotFoundError();

    if (campaign.audience.kind === 'groups') {
      return buildGroupsPreflightQuote(tx, {
        clientId: input.clientId,
        broadcastId: input.id,
        instanceId,
        audience: campaign.audience,
        payloadKind: campaign.message.kind,
        thresholds,
      });
    }

    // C1 fix F2 (MINOR 4): "no plan" != "plan's ceiling exceeded" - checked pre-walk, never a fabricated "limit (0)".
    const limit = await resolveEffectiveMaxBroadcastRecipients(tx, input.clientId);
    if (limit === null) {
      throw new PreflightNoPlanError();
    }

    // countAudience is ONLY this pre-walk ceiling check, never the quote's `matched` (MINOR 5).
    const match = audienceMatchParams(campaign.audience);
    const preCheckMatched = await countAudience(tx, input.clientId, match);
    if (preCheckMatched > limit) {
      throw new PreflightAudienceOverLimitError(preCheckMatched, limit);
    }

    const contactsCampaign = campaign as typeof campaign & { audience: ContactsAudienceJson };
    const walked = await walkPreflightAudience(tx, input.clientId, contactsCampaign);
    const deferred = await countDeferralsInBatches(tx, input.clientId, walked.sendableHashes, {
      perRecipient24h: thresholds.perRecipient24h,
      perRecipient7d: thresholds.perRecipient7d,
    });
    // `matched` is DERIVED from the walk (sendable + skipped) - never disagreeing with it.
    const matched = walked.sendableHashes.length + walked.skipped;
    const { skipped, sendable, billable } = computeBillable({
      matched,
      skipReasons: walked.skipReasons,
      deferred,
    });
    const priceKey = resolvePriceKey({
      payloadKind: campaign.message.kind,
      recipientJid: 'individual',
    });
    const rateMinor = await resolveRateMinor(tx, input.clientId, priceKey);
    const quoteMinor = computeQuoteMinor(billable, rateMinor);
    await stampPreflightQuote(tx, input.clientId, input.id, quoteMinor, priceKey);
    const sentToday = await readPreflightSentToday(tx, input.clientId, instanceId);
    const balanceMinor = (await readPreflightWalletBalance(tx, input.clientId)) ?? 0;
    const afterMinor = balanceMinor - quoteMinor;
    const estimate = computeEstimate({
      billable,
      effDailyCap: thresholds.effDailyCap,
      sentToday,
      now: new Date(),
    });

    const quote: BroadcastPreflight = {
      broadcastId: input.id,
      audience: { matched, skipped, skipReasons: walked.skipReasons, sendable },
      alreadyMessaged: {
        deferred,
        perRecipient24h: thresholds.perRecipient24h,
        perRecipient7d: thresholds.perRecipient7d,
        note: BROADCAST_FREQUENCY_NOTE,
      },
      billable: { count: billable, priceKey, rateMinor, quoteMinor },
      wallet: { balanceMinor, afterMinor, sufficient: afterMinor >= 0 },
      account: {
        instanceId,
        label: thresholds.label,
        warmupTier: thresholds.warmupTier,
        effDailyCap: thresholds.effDailyCap,
        sentToday,
        remainingToday: estimate.remainingToday,
      },
      estimate: {
        totalDays: estimate.totalDays,
        finishAt: estimate.finishAt,
        caveat: BROADCAST_ESTIMATE_CAVEAT,
        options: [...estimate.options],
      },
      fanOut: {
        warnThreshold: thresholds.dupFanoutWarn,
        ackThreshold: thresholds.dupFanoutAck,
        requiresHumanAck: billable > thresholds.dupFanoutAck,
      },
      disclosure: BROADCAST_DISCLOSURE,
    };

    return broadcastPreflightSchema.parse(quote);
  });
}
