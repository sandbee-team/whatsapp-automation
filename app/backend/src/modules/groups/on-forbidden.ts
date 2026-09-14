import { loadQuery, bindQueryParams, type TenantQueryable } from '@wp/db';
import { groupRecipientHashInput, isGroupJid } from '@wp/domain';
import { provisioningRepo } from '../tenancy/index.js';
import { notify } from '../notifications/index.js';
import { bindGroupsMetrics } from '../../platform/metrics/groups-metrics.js';

/**
 * on-forbidden.ts (P24 Unit U4b, step 7) - `handleGroupForbidden`, the ONE
 * write sequence a `group_forbidden` terminal send failure runs, IN THE SAME
 * TRANSACTION as the job's own terminal UPDATE (the caller, `result-
 * terminal.ts`, passes its own `tx` in - there is no overload that opens a
 * transaction here, same discipline `notify()`'s own module header
 * documents): disable the ONE target group, audit it, notify the tenant
 * once (deduped per group), and count the metric. Never touches the
 * instance's own health/pause columns, the per-instance pacing-state row,
 * the pacing-events table, or anything under `modules/pacing/health/**` - a
 * `group_forbidden` rejection is terminal for ONE job/group only (core
 * invariant 2's documented carve-out, `classify.ts`'s own module doc). This
 * guarantee is scanned structurally by a sibling integration test - keep
 * this file's own prose free of the literal column/table names it greps for.
 *
 * A group `wa_groups` has never synced (no row yet) is NOT an error: the
 * disable UPDATE matches zero rows, and this function skips the audit/notify
 * writes and returns - the job's own terminal failure already recorded the
 * outcome on `message_jobs`/`delivery_events`, which is the durable record
 * that matters when the group registry has not caught up yet.
 */

export interface HandleGroupForbiddenInput {
  clientId: string;
  instanceId: string;
  jobPublicId: string;
  /** The raw provider-supplied recipient jid (`@g.us`) - canonicalised here via `groupRecipientHashInput` before every read/write below. */
  recipientJid: string;
}

export async function handleGroupForbidden(
  tx: TenantQueryable,
  input: HandleGroupForbiddenInput,
): Promise<void> {
  const groupJid = groupRecipientHashInput(input.recipientJid);

  const query = await loadQuery('group-disable-on-forbidden');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    group_jid: groupJid,
  });
  const result = await tx.query<{ id: string; enabled_epoch: Date | null }>(query.text, params);
  const row = result.rows[0];

  bindGroupsMetrics().incrementGroupSend('group_forbidden');

  if (!row) {
    // Never synced (or already left) - nothing to audit/notify against.
    return;
  }
  const groupId = row.id;

  await provisioningRepo.insertAuditLog(tx, {
    clientId: input.clientId,
    actorType: 'system',
    action: 'group.send_disabled',
    targetType: 'wa_group',
    targetId: groupId,
    metadata: { reason: 'group_forbidden' },
  });

  // The dedupe bucket includes the ENABLE CYCLE (P24 C2 fix round, Fix 6):
  // `enabled_epoch` is this group's own `send_enabled_at` as it was BEFORE
  // this disable - the same group re-enabled and forbidden again carries a
  // NEW `send_enabled_at`, so it gets a fresh notification instead of
  // colliding with the first event's dedupe key forever.
  await notify(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    kind: 'group_forbidden',
    transitionId: groupId,
    bucket: row.enabled_epoch ? row.enabled_epoch.toISOString() : 'never',
    payload: { groupId, reason: 'group_forbidden' },
  });
}

export interface TouchGroupLastMessageInput {
  clientId: string;
  instanceId: string;
  /** The raw chat jid (`key.remoteJid`) - a non-`@g.us` value is a no-op (nothing to touch). */
  remoteJid: string;
  at: Date;
}

/**
 * Advances `wa_groups.last_message_at` for an inbound group chat message that
 * passed the message-scope filter (P24 Unit U4b, step 8). A no-op for a
 * non-group `remoteJid` (every DM chat) and for a group never synced into
 * `wa_groups` (zero rows matched - best-effort metadata, never a required
 * side effect of message processing).
 */
export async function touchGroupLastMessage(
  tx: TenantQueryable,
  input: TouchGroupLastMessageInput,
): Promise<void> {
  if (!isGroupJid(input.remoteJid)) {
    return;
  }
  const groupJid = groupRecipientHashInput(input.remoteJid);
  const query = await loadQuery('groups-touch-last-message');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    group_jid: groupJid,
    at: input.at,
  });
  await tx.query(query.text, params);
}
