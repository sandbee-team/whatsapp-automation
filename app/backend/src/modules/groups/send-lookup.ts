import { loadQuery, bindQueryParams, type TenantQueryable } from '@wp/db';
import { canSendToGroup, type GroupRole, type GroupSendIneligibilityReason } from '@wp/domain';

/**
 * send-lookup.ts (P24 groups-messaging, Unit U4a, step 6) - the ONE read
 * `messages.service.ts#createMessage` runs, inside its own already-open
 * `withTenant` transaction, to resolve a `@g.us` recipient's send
 * eligibility at enqueue time. Runs `db/queries/group-send-lookup.sql`
 * (one SELECT, no write) and folds the result through `@wp/domain`'s
 * `canSendToGroup` - this file never re-implements the eligibility rule
 * itself.
 *
 * Deliberately independent of U3's `groups.errors.ts` (the two units run in
 * parallel on disjoint files - see the phase's W3 common contract):
 * `GroupSendRejectedError` below is this unit's OWN tiny error class, not a
 * shared one.
 */

export class GroupSendRejectedError extends Error {
  readonly code = 'GROUP_NOT_SENDABLE';
  readonly details: { reason: GroupSendIneligibilityReason };
  constructor(reason: GroupSendIneligibilityReason) {
    super('This group is not eligible to receive messages.');
    this.name = 'GroupSendRejectedError';
    this.details = { reason };
  }
}

export interface GroupEnqueueLookup {
  /** `undefined` sendable means the group defers at reserve() time (`GROUP_CAP_ZERO_AT_TIER`) rather than being rejected at the API - the caller still enqueues the job. */
  sendable: boolean;
  reason?: GroupSendIneligibilityReason;
}

interface GroupSendLookupRow extends Record<string, unknown> {
  id: string;
  send_enabled: boolean;
  is_announce: boolean;
  our_role: GroupRole | null;
  tracked_participant_devices: number;
  left_at: Date | null;
  eff_group_daily_cap: number | null;
  enabled_devices_total: string;
}

export interface ResolveGroupForEnqueueInput {
  clientId: string;
  instanceId: string;
  /** The CANONICAL group jid (`groupRecipientHashInput`'s output) - never the raw caller-supplied jid. */
  canonicalGroupJid: string;
}

/**
 * Resolves send eligibility for a `@g.us` recipient at enqueue time. No row
 * (never synced) or a `left_at`-set row is treated as `NOT_SEND_ENABLED` -
 * from the API caller's point of view a group we have left is
 * indistinguishable from one that was never send-enabled (fail-closed,
 * core invariant 2). A null `eff_group_daily_cap` (instance not yet
 * provisioned into `instance_pacing_state`) is treated as `0`, never as
 * unlimited - same fail-closed reasoning.
 */
export async function resolveGroupForEnqueue(
  tx: TenantQueryable,
  input: ResolveGroupForEnqueueInput,
): Promise<GroupEnqueueLookup> {
  const query = await loadQuery('group-send-lookup');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    group_jid: input.canonicalGroupJid,
  });
  const result = await tx.query<GroupSendLookupRow>(query.text, params);
  const row = result.rows[0];
  if (!row || row.left_at !== null) {
    return { sendable: false, reason: 'NOT_SEND_ENABLED' };
  }

  return canSendToGroup({
    sendEnabled: row.send_enabled,
    isAnnounce: row.is_announce,
    ourRole: row.our_role,
    effGroupDailyCap: row.eff_group_daily_cap ?? 0,
    trackedDevicesInstanceTotal: Number(row.enabled_devices_total),
    groupTrackedDevices: row.tracked_participant_devices,
  });
}
