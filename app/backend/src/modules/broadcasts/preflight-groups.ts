import type { TenantQueryable } from '@wp/db';
import { GROUP_RISK_DISCLOSURE, canSendToGroup, resolvePriceKey } from '@wp/domain';
import type { BroadcastPreflight, BroadcastPreflightSkipReason } from '@wp/contracts';
import { broadcastPreflightSchema } from '@wp/contracts';
import {
  BROADCAST_ESTIMATE_CAVEAT,
  BROADCAST_FREQUENCY_NOTE,
  BROADCAST_DISCLOSURE,
} from '@wp/domain';
import { resolveRateMinor } from '../wallet/index.js';
import { groupsAudienceMatchParams, type GroupsAudienceJson } from './audience.js';
import {
  readEffGroupDailyCap,
  readGroupSnapshotBatch,
  readGroupTrackedDevicesInstanceTotal,
  type GroupAudienceRow,
} from './audience-groups.js';
import { computeEstimate, computeQuoteMinor } from './preflight.service.js';
import type { PreflightInstanceThresholds } from './preflight.repo.js';
import {
  readGroupSentToday,
  readPreflightWalletBalance,
  stampPreflightQuote,
} from './preflight.repo.js';

/**
 * preflight-groups.ts (P24 groups-messaging Unit U6, step 9) - the ENTIRE
 * `groups`-campaign pre-flight quote, split out of `preflight.service.ts`
 * (already at the 300-line cap before this phase) so that file gains only a
 * one-branch call. Walks the SAME `wa_groups` population/skip precedence
 * `audience-groups.ts`'s snapshot batch runner uses, so the quote never
 * disagrees with what the snapshot will actually write; prices at
 * `resolvePriceKey`'s `group_text`/`group_media` key; folds into the SAME
 * wallet/fanOut/disclosure shape `preflightBroadcast`'s contacts body uses
 * (never a second, independently-drifting quote shape). Groups skip the
 * per-recipient frequency guard and the plan-ceiling check entirely (see
 * `snapshot.worker.ts`'s own comment on why groups have no ceiling
 * authority) - `alreadyMessaged.deferred` is always 0.
 */

const GROUPS_BATCH_SIZE = 1_000;

interface GroupsWalk {
  matched: number;
  skipped: number;
  skipReasons: BroadcastPreflightSkipReason[];
  billable: number;
  reachEstimate: number;
  priceKey: 'group_text' | 'group_media';
  effGroupDailyCap: number;
  groupSentToday: number;
}

/** Walks every matched group, mirroring `audience-groups.ts#groupAudienceRowToRecipient`'s own skip precedence exactly. */
async function walkGroupsAudience(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  audience: GroupsAudienceJson,
  payloadKind: string,
): Promise<GroupsWalk> {
  const { groupIds } = groupsAudienceMatchParams(audience);

  const [effGroupDailyCap, trackedDevicesInstanceTotal, groupSentToday] = await Promise.all([
    readEffGroupDailyCap(tx, clientId, instanceId),
    readGroupTrackedDevicesInstanceTotal(tx, clientId, instanceId),
    readGroupSentToday(tx, clientId, instanceId),
  ]);
  const cap = effGroupDailyCap ?? 0;

  const skipCounts = new Map<string, number>();
  const skipOrder: string[] = [];
  let reachEstimate = 0;
  let sendableCount = 0;
  let cursor: string | null = null;

  for (;;) {
    const rows: GroupAudienceRow[] = await readGroupSnapshotBatch(tx, {
      clientId,
      instanceId,
      cursorGroupId: cursor,
      groupIds,
      batchSize: GROUPS_BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      reachEstimate += row.participant_count ?? 0;
      const eligibility = canSendToGroup({
        sendEnabled: row.send_enabled,
        isAnnounce: row.is_announce,
        ourRole: row.our_role,
        effGroupDailyCap: cap,
        trackedDevicesInstanceTotal,
        groupTrackedDevices: row.tracked_participant_devices,
      });
      if (!eligibility.sendable && eligibility.reason !== 'GROUP_CAP_ZERO_AT_TIER') {
        if (!skipCounts.has(eligibility.reason)) skipOrder.push(eligibility.reason);
        skipCounts.set(eligibility.reason, (skipCounts.get(eligibility.reason) ?? 0) + 1);
      } else {
        sendableCount += 1;
      }
    }

    cursor = rows[rows.length - 1]!.group_id;
    if (rows.length < GROUPS_BATCH_SIZE) break;
  }

  const skipReasons = skipOrder.map((reason) => ({ reason, count: skipCounts.get(reason)! }));
  const skipped = skipReasons.reduce((sum, r) => sum + r.count, 0);
  const matched = sendableCount + skipped;

  return {
    matched,
    skipped,
    skipReasons,
    billable: matched - skipped,
    reachEstimate,
    priceKey: resolvePriceKey({ payloadKind, recipientJid: '1@g.us' }) as
      'group_text' | 'group_media',
    effGroupDailyCap: cap,
    groupSentToday,
  };
}

export interface BuildGroupsPreflightQuoteInput {
  clientId: string;
  broadcastId: string;
  instanceId: string;
  audience: GroupsAudienceJson;
  payloadKind: string;
  thresholds: PreflightInstanceThresholds;
}

/** Builds and validates the FULL `BroadcastPreflight` quote for a `groups` campaign. */
export async function buildGroupsPreflightQuote(
  tx: TenantQueryable,
  input: BuildGroupsPreflightQuoteInput,
): Promise<BroadcastPreflight> {
  const walk = await walkGroupsAudience(
    tx,
    input.clientId,
    input.instanceId,
    input.audience,
    input.payloadKind,
  );

  const rateMinor = await resolveRateMinor(tx, input.clientId, walk.priceKey);
  const quoteMinor = computeQuoteMinor(walk.billable, rateMinor);
  await stampPreflightQuote(tx, input.clientId, input.broadcastId, quoteMinor, walk.priceKey);
  const balanceMinor = (await readPreflightWalletBalance(tx, input.clientId)) ?? 0;
  const afterMinor = balanceMinor - quoteMinor;
  const estimate = computeEstimate({
    billable: walk.billable,
    effDailyCap: walk.effGroupDailyCap,
    sentToday: walk.groupSentToday,
    now: new Date(),
  });

  const quote: BroadcastPreflight = {
    broadcastId: input.broadcastId,
    audience: {
      matched: walk.matched,
      skipped: walk.skipped,
      skipReasons: walk.skipReasons,
      sendable: walk.billable,
    },
    alreadyMessaged: {
      deferred: 0,
      perRecipient24h: input.thresholds.perRecipient24h,
      perRecipient7d: input.thresholds.perRecipient7d,
      note: BROADCAST_FREQUENCY_NOTE,
    },
    billable: { count: walk.billable, priceKey: walk.priceKey, rateMinor, quoteMinor },
    wallet: { balanceMinor, afterMinor, sufficient: afterMinor >= 0 },
    account: {
      instanceId: input.instanceId,
      label: input.thresholds.label,
      warmupTier: input.thresholds.warmupTier,
      effDailyCap: walk.effGroupDailyCap,
      sentToday: walk.groupSentToday,
      remainingToday: estimate.remainingToday,
    },
    estimate: {
      totalDays: estimate.totalDays,
      finishAt: estimate.finishAt,
      caveat: BROADCAST_ESTIMATE_CAVEAT,
      options: [...estimate.options],
    },
    fanOut: {
      warnThreshold: input.thresholds.dupFanoutWarn,
      ackThreshold: input.thresholds.dupFanoutAck,
      requiresHumanAck: walk.billable > input.thresholds.dupFanoutAck,
    },
    disclosure: BROADCAST_DISCLOSURE,
    groups: {
      groupsMatched: walk.matched,
      groupsSkipped: walk.skipped,
      skipReasons: walk.skipReasons,
      reachEstimate: walk.reachEstimate,
      reachIsApproximate: true,
      effGroupDailyCap: walk.effGroupDailyCap,
      groupSentToday: walk.groupSentToday,
      groupRemainingToday: estimate.remainingToday,
      capIsZeroAtTier: walk.effGroupDailyCap === 0,
      riskDisclosure: GROUP_RISK_DISCLOSURE,
    },
  };

  return broadcastPreflightSchema.parse(quote);
}
