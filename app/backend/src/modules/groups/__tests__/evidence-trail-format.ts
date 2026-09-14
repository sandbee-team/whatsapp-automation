import type { TenantDb } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { seedQueuedJob } from '../../../engine/queue/__tests__/queue-send-test-helpers.js';
import {
  createFakeTransport,
  enqueueVia,
  jobIdForPublicId,
  resetMinGap,
  runOneIteration,
} from './send-test-helpers.js';

type Pool = { query: <T>(text: string, params?: unknown[]) => Promise<{ rows: T[] }> };

/**
 * modules/groups/__tests__/evidence-trail-format.ts (P24 U7, step 10; P24 C1
 * FIX ROUND, Finding 2) - the ids/hashes/counts-only block formatter for
 * `evidence-trail.integration.test.ts`, plus `runForbiddenPathForEvidence`
 * (the Part 3 fixture drive). Drives the forbidden path through the REAL
 * wired send loop (`enqueueVia` -> `runOneIteration`, the SAME production
 * `claimOne -> reserve -> dispatch -> resolveFailure` chain `send.
 * integration.test.ts` uses) rather than calling `resolveFailure` directly -
 * the exact gap Finding 1's fix closed (`send-loop.ts` used to omit
 * `recipientJid` from its `resolveFailure` call, so a direct-call test never
 * proved the hook fires in production). Never accepts a group subject, JID,
 * or phone as input beyond what the shared fixtures already generate
 * synthetically.
 */

export interface ForbiddenPathResult {
  groupId: string;
  groupSendEnabled: boolean;
  groupDisabledReason: string | null;
  groupNextSyncAfterIsNotNull: boolean;
  auditAction: string | undefined;
  replayDeduped: boolean;
  instanceHealthStateBefore: string | undefined;
  instanceHealthStateAfter: string | undefined;
  instancePauseReasonBefore: string | null | undefined;
  instancePauseReasonAfter: string | null | undefined;
}

/** Drives one `group_forbidden` terminal failure plus a replay on the SAME group through the REAL wired send loop (`enqueueVia` -> `runOneIteration`), then reads back every column Part 3 of the evidence doc needs - the exact sequence `forbidden-edge.integration.test.ts`'s dedupe case already proves green, now through production wiring instead of a direct `resolveFailure` call. */
export async function runForbiddenPathForEvidence(
  pool: Pool,
  tenantDb: TenantDb,
  keyProvider: KeyProvider,
  clientId: string,
  instanceId: string,
  groupJid: string,
  groupDbId: string,
): Promise<ForbiddenPathResult> {
  const instanceBefore = await pool.query<{ health_state: string; pause_reason: string | null }>(
    'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
    [instanceId],
  );

  const transport = createFakeTransport();
  transport.queueReject(0, 'group_forbidden');
  const enqueued = await enqueueVia(tenantDb, keyProvider, clientId, instanceId, groupJid);
  // Part 1's own send already consumed this instance's pacing min-gap -
  // reset it so this Part 3 send is immediately eligible too (same idiom
  // `send.integration.test.ts` uses between its own two claims).
  await resetMinGap(pool as never, instanceId);
  const claimed = await runOneIteration(tenantDb, pool as never, {
    clientId,
    instanceId,
    transport,
  });
  if (!claimed) {
    throw new Error('runForbiddenPathForEvidence: the first forbidden send was never claimed');
  }
  const jobId = await jobIdForPublicId(pool as never, clientId, enqueued.id);
  const jobRow = await pool.query<{ status: string }>(
    'SELECT status FROM message_jobs WHERE id = $1',
    [jobId],
  );
  if (jobRow.rows[0]?.status !== 'failed') {
    throw new Error('runForbiddenPathForEvidence: the first forbidden send never went terminal');
  }
  const instanceAfter = await pool.query<{ health_state: string; pause_reason: string | null }>(
    'SELECT health_state, pause_reason FROM whatsapp_instances WHERE id = $1',
    [instanceId],
  );

  const groupRow = await pool.query<{
    id: string;
    send_enabled: boolean;
    disabled_reason: string | null;
    next_sync_after: Date | null;
  }>('SELECT id, send_enabled, disabled_reason, next_sync_after FROM wa_groups WHERE id = $1', [
    groupDbId,
  ]);
  const auditRows = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE client_id = $1 AND action = 'group.send_disabled'`,
    [clientId],
  );
  const notificationsFirst = await pool.query<{ id: string }>(
    `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
    [clientId],
  );

  // Replay: a SECOND forbidden result on the SAME (now-disabled) group -
  // models a job that was already queued before the disable landed, still
  // reaching the send loop afterward (`seedQueuedJob`, never the API
  // enqueue path, which would itself reject an already-disabled group).
  transport.queueReject(0, 'group_forbidden');
  const replayJob = await seedQueuedJob(pool as never, {
    clientId,
    instanceId,
    recipientJid: groupJid,
  });
  await resetMinGap(pool as never, instanceId);
  const replayClaimed = await runOneIteration(tenantDb, pool as never, {
    clientId,
    instanceId,
    transport,
  });
  if (!replayClaimed) {
    throw new Error('runForbiddenPathForEvidence: the replay forbidden send was never claimed');
  }
  const replayJobRow = await pool.query<{ status: string }>(
    'SELECT status FROM message_jobs WHERE id = $1',
    [replayJob.id],
  );
  if (replayJobRow.rows[0]?.status !== 'failed') {
    throw new Error('runForbiddenPathForEvidence: the replay forbidden send never went terminal');
  }
  const notificationsSecond = await pool.query<{ id: string }>(
    `SELECT id FROM notifications WHERE client_id = $1 AND kind = 'group_forbidden'`,
    [clientId],
  );

  const g = groupRow.rows[0];
  return {
    groupId: g?.id ?? '',
    groupSendEnabled: g?.send_enabled ?? false,
    groupDisabledReason: g?.disabled_reason ?? null,
    groupNextSyncAfterIsNotNull: (g?.next_sync_after ?? null) !== null,
    auditAction: auditRows.rows[0]?.action,
    replayDeduped: notificationsSecond.rows.length === notificationsFirst.rows.length,
    instanceHealthStateBefore: instanceBefore.rows[0]?.health_state,
    instanceHealthStateAfter: instanceAfter.rows[0]?.health_state,
    instancePauseReasonBefore: instanceBefore.rows[0]?.pause_reason,
    instancePauseReasonAfter: instanceAfter.rows[0]?.pause_reason,
  };
}

export interface EvidenceTrailFields {
  jobPublicIdHash: string;
  jobIdHash: string;
  jobStatus: unknown;
  jobLastErrorClass: unknown;
  jobRecipientE164: unknown;
  jobIsNewConversation: unknown;
  ledgerBefore: { consumed_count: number; group_sent_count: number; new_conv_count: number };
  ledgerAfter: { consumed_count: number; group_sent_count: number; new_conv_count: number };
  walletPriceKey: unknown;
  walletAmountMinor: unknown;
  walletGuardCount: unknown;
  receiptDistinctCount: number;
  groupIdHash: string;
  groupSendEnabled: unknown;
  groupDisabledReason: unknown;
  groupNextSyncAfterIsNotNull: unknown;
  auditAction: unknown;
  notificationsReplayDeduped: unknown;
  instanceHealthStateBefore: unknown;
  instanceHealthStateAfter: unknown;
  instancePauseReasonBefore: unknown;
  instancePauseReasonAfter: unknown;
}

/** Builds the full delimited evidence block; `attemptLines`/`sentEventLines`/`receiptLines` are pre-formatted `  key=value` lines the caller already produced from its own per-row hashing. */
export function buildEvidenceTrailBlock(
  f: EvidenceTrailFields,
  attemptLines: string[],
  sentEventLines: string[],
  receiptLines: string[],
): string {
  const lb = f.ledgerBefore;
  const la = f.ledgerAfter;
  const lines: string[] = [
    '=== P24-EVIDENCE-TRAIL-START ===',
    '-- one real group send --',
    `message_jobs.public_id_sha256=${f.jobPublicIdHash}`,
    `message_jobs.id_sha256=${f.jobIdHash}`,
    `message_jobs.status=${String(f.jobStatus)}`,
    `message_jobs.last_error_class=${String(f.jobLastErrorClass)}`,
    `message_jobs.recipient_e164=${String(f.jobRecipientE164)}`,
    `message_jobs.is_new_conversation=${String(f.jobIsNewConversation)}`,
    ...attemptLines,
    ...sentEventLines,
    `pacing_ledger.consumed_count.before=${String(lb.consumed_count)}`,
    `pacing_ledger.consumed_count.after=${String(la.consumed_count)}`,
    `pacing_ledger.group_sent_count.before=${String(lb.group_sent_count)}`,
    `pacing_ledger.group_sent_count.after=${String(la.group_sent_count)}`,
    `pacing_ledger.new_conv_count.before=${String(lb.new_conv_count)}`,
    `pacing_ledger.new_conv_count.after=${String(la.new_conv_count)}`,
    `wallet_ledger.price_key=${String(f.walletPriceKey)}`,
    `wallet_ledger.amount_minor=${String(f.walletAmountMinor)}`,
    `wallet_charge_guards.count=${String(f.walletGuardCount)}`,
    '-- three synthetic participant receipts, same wa_msg_id --',
    ...receiptLines,
    `delivery_events.delivered.distinct_count=${String(f.receiptDistinctCount)}`,
    '-- one group_forbidden path, sibling enabled group --',
    `wa_groups.id_sha256=${f.groupIdHash}`,
    `wa_groups.send_enabled=${String(f.groupSendEnabled)}`,
    `wa_groups.disabled_reason=${String(f.groupDisabledReason)}`,
    `wa_groups.next_sync_after_is_not_null=${String(f.groupNextSyncAfterIsNotNull)}`,
    `audit_logs.action=${String(f.auditAction)}`,
    `notifications.kind=group_forbidden`,
    `notifications.created=true`,
    `notifications.replay_deduped=${String(f.notificationsReplayDeduped)}`,
    `whatsapp_instances.health_state.before=${String(f.instanceHealthStateBefore)}`,
    `whatsapp_instances.health_state.after=${String(f.instanceHealthStateAfter)}`,
    `whatsapp_instances.pause_reason.before=${String(f.instancePauseReasonBefore)}`,
    `whatsapp_instances.pause_reason.after=${String(f.instancePauseReasonAfter)}`,
    '=== P24-EVIDENCE-TRAIL-END ===',
  ];
  return lines.join('\n');
}
