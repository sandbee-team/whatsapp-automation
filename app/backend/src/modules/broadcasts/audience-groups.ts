import type { TenantQueryable } from '@wp/db';
import { bindQueryParams, loadQuery } from '@wp/db';
import type { KeyProvider } from '@wp/server-kit/crypto';
import { canSendToGroup, groupRecipientHashInput, isGroupJid } from '@wp/domain';
import { hashRecipient } from '../../platform/crypto/phone-hash.js';
import {
  advanceSnapshotCursor,
  bumpSnapshotCounters,
  completeSnapshot,
  insertRecipientBatch,
  type RecipientInsertRow,
} from './snapshot.repo.js';
import type { SnapshotBatchResult } from './snapshot.worker.js';

/**
 * audience-groups.ts (P24 groups-messaging Unit U6, step 9) - the `groups`
 * audience's own snapshot-time reads and per-row eligibility mapping, split
 * out of `snapshot.repo.ts`/`snapshot.worker.ts` so neither file needs to
 * grow past its own header's line budget for a second audience kind. Mirrors
 * `snapshot-audience-count.sql`/`snapshot-audience-batch.sql`'s contacts
 * shape exactly: one ceiling count (run only on the very first batch) plus
 * one keyset batch read, each scoped by `client_id` (core invariant 4).
 *
 * `GROUP_CAP_ZERO_AT_TIER` is deliberately NOT a skip reason here (see
 * `send-eligibility.ts`'s own doc comment on `API_TIME_REJECTION_REASONS`):
 * a cap-zero-at-tier group still snapshots as `pending` - the daily cap is
 * enforced once, by `reserve-pacing.sql`, at send time, never twice.
 */

export interface GroupAudienceRow extends Record<string, unknown> {
  group_id: string;
  group_jid: string;
  subject: string | null;
  participant_count: number | null;
  is_announce: boolean;
  our_role: 'member' | 'admin' | 'superadmin' | null;
  send_enabled: boolean;
  tracked_participant_devices: number;
}

/** Ceiling-check twin of `countAudience` (contacts) - counts every non-left group the audience JSON matches, on the campaign's own instance. */
export async function countGroupAudience(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
  groupIds: string[],
): Promise<number> {
  const query = await loadQuery('snapshot-groups-count');
  const result = await tx.query<{ count: string }>(
    query.text,
    bindQueryParams(query, { client_id: clientId, instance_id: instanceId, group_ids: groupIds }),
  );
  return Number(result.rows[0]?.count ?? 0);
}

export interface GroupSnapshotBatchOptions {
  clientId: string;
  instanceId: string;
  cursorGroupId: string | null;
  groupIds: string[];
  batchSize: number;
}

/** Reads the next batch of matched groups strictly after the cursor. Empty result means exhaustion. */
export async function readGroupSnapshotBatch(
  tx: TenantQueryable,
  options: GroupSnapshotBatchOptions,
): Promise<GroupAudienceRow[]> {
  const query = await loadQuery('snapshot-groups-batch');
  const result = await tx.query<GroupAudienceRow>(
    query.text,
    bindQueryParams(query, {
      client_id: options.clientId,
      instance_id: options.instanceId,
      cursor_group_id: options.cursorGroupId ?? '00000000-0000-0000-0000-000000000000',
      group_ids: options.groupIds,
      batch_size: options.batchSize,
    }),
  );
  return result.rows;
}

/** The instance-wide tracked-device total `canSendToGroup` needs - read ONCE per batch (never per row), reusing U3's own list-route query. */
export async function readGroupTrackedDevicesInstanceTotal(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number> {
  const query = await loadQuery('groups-enabled-devices-total');
  const result = await tx.query<{ total: number }>(
    query.text,
    bindQueryParams(query, { client_id: clientId, instance_id: instanceId }),
  );
  return result.rows[0]?.total ?? 0;
}

/** The instance's effective group daily cap - `canSendToGroup`'s `effGroupDailyCap` input, read once per batch. `undefined` when the instance has no pacing state row (treated as cap 0 - see the caller). */
export async function readEffGroupDailyCap(
  tx: TenantQueryable,
  clientId: string,
  instanceId: string,
): Promise<number | undefined> {
  const query = await loadQuery('groups-cap-today');
  const result = await tx.query<{ eff_group_daily_cap: number }>(
    query.text,
    bindQueryParams(query, { client_id: clientId, instance_id: instanceId }),
  );
  return result.rows[0]?.eff_group_daily_cap;
}

/**
 * Maps one `wa_groups` row to its `campaign_recipients` insert row, per the
 * binding skip precedence (task semantics): `NOT_SEND_ENABLED` /
 * `ANNOUNCE_MEMBER_ONLY` -> `skipped`; `GROUP_CAP_ZERO_AT_TIER` -> NOT
 * skipped, a `pending` row that defers with `GROUP_DAILY_CAP` at send time
 * (the cap is enforced by `reserve()`, never by the snapshot);
 * `DEVICE_BUDGET_EXCEEDED` cannot occur for an already send-enabled group
 * (enable-time-only refusal - see `send-eligibility.ts`'s own doc comment).
 * `vars` is always `{}` - groups never resolve `{{token}}` templates (a
 * template with variables is rejected at create time, see
 * `lifecycle.service.ts#assertGroupsAudienceHasNoTemplateVars`).
 */
export function groupAudienceRowToRecipient(
  row: GroupAudienceRow,
  recipientHash: Buffer,
  effGroupDailyCap: number,
  trackedDevicesInstanceTotal: number,
): RecipientInsertRow {
  if (!isGroupJid(row.group_jid)) {
    throw new RangeError(`groupAudienceRowToRecipient: "${row.group_jid}" is not a @g.us jid`);
  }

  const eligibility = canSendToGroup({
    sendEnabled: row.send_enabled,
    isAnnounce: row.is_announce,
    ourRole: row.our_role,
    effGroupDailyCap,
    trackedDevicesInstanceTotal,
    groupTrackedDevices: row.tracked_participant_devices,
  });

  const base = {
    contactId: null,
    groupId: row.group_id,
    recipientJid: row.group_jid,
    recipientE164: null,
    recipientHash,
    vars: {},
  };

  if (!eligibility.sendable && eligibility.reason !== 'GROUP_CAP_ZERO_AT_TIER') {
    return { ...base, status: 'skipped', skipReason: eligibility.reason };
  }
  return { ...base, status: 'pending', skipReason: null };
}

/**
 * Runs exactly one groups-audience snapshot batch, inside the caller's own
 * `withTenant` transaction - the groups twin of `snapshot.worker.ts#
 * runSnapshotBatch`'s contacts body, factored out here purely so that file
 * stays under the line cap for a second audience kind (never a second,
 * independently-drifting cursor/counter/completion authority: this function
 * calls the SAME `advanceSnapshotCursor`/`bumpSnapshotCounters`/
 * `completeSnapshot` the contacts path uses).
 */
export async function runGroupsSnapshotBatch(
  tx: TenantQueryable,
  keyProvider: KeyProvider,
  input: { clientId: string; instanceId: string; campaignId: string },
  cursorGroupId: string | null,
  groupIds: string[],
  batchSize: number,
): Promise<SnapshotBatchResult> {
  const rows = await readGroupSnapshotBatch(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    cursorGroupId,
    groupIds,
    batchSize,
  });

  if (rows.length === 0) {
    const result = await completeSnapshot(tx, input.clientId, input.campaignId, 'expanding');
    return { kind: 'done', audienceCount: result.audienceCount };
  }

  const [effGroupDailyCap, trackedDevicesInstanceTotal] = await Promise.all([
    readEffGroupDailyCap(tx, input.clientId, input.instanceId),
    readGroupTrackedDevicesInstanceTotal(tx, input.clientId, input.instanceId),
  ]);

  const insertRows: RecipientInsertRow[] = rows.map((row) =>
    groupAudienceRowToRecipient(
      row,
      hashRecipient(keyProvider, groupRecipientHashInput(row.group_jid)),
      effGroupDailyCap ?? 0,
      trackedDevicesInstanceTotal,
    ),
  );

  const inserted = await insertRecipientBatch(tx, input.clientId, input.campaignId, insertRows);
  const maxGroupId = rows[rows.length - 1]?.group_id;
  if (maxGroupId === undefined) {
    throw new Error('runGroupsSnapshotBatch: batch had rows but no max group id');
  }

  await advanceSnapshotCursor(tx, input.clientId, input.campaignId, maxGroupId);
  await bumpSnapshotCounters(tx, input.clientId, input.campaignId, {
    total: inserted.insertedCount,
    pending: inserted.pendingCount,
    skipped: inserted.skippedCount,
  });

  if (rows.length < batchSize) {
    const result = await completeSnapshot(tx, input.clientId, input.campaignId, 'expanding');
    return { kind: 'done', audienceCount: result.audienceCount };
  }

  return {
    kind: 'batch',
    inserted: inserted.pendingCount,
    skipped: inserted.skippedCount,
    cursor: maxGroupId,
  };
}
