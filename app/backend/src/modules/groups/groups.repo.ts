import { loadQuery, bindQueryParams } from '@wp/db';
import type { TenantQueryable } from '@wp/db';
import { GROUP_SYNC_MIN_INTERVAL_MS } from '@wp/domain';

/**
 * groups.repo.ts (P24 Unit U3, step 4/5) - SQL-only DB access for the
 * tenant `wa_groups` surface (list/get/enable-disable/leave) plus the
 * worker-side counterparts a sibling repo function set never touches
 * directly (`sync.ts` calls its own small set of loaders inline - see that
 * file). No ORM re-implementation - every predicate lives inside the loaded
 * SQL text itself (same discipline as `broadcasts.repo.ts`/`instances/repo.ts`).
 */

export interface GroupRow extends Record<string, unknown> {
  id: string;
  instance_id: string;
  subject: string | null;
  participant_count: number | null;
  is_announce: boolean;
  our_role: 'member' | 'admin' | 'superadmin' | null;
  send_enabled: boolean;
  send_enabled_at: Date | null;
  disabled_reason: string | null;
  tracked_participant_devices: number;
  last_synced_at: Date | null;
  last_message_at: Date | null;
  leave_requested_at: Date | null;
}

export async function listGroups(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string; afterId: string | null; limit: number },
): Promise<GroupRow[]> {
  const query = await loadQuery('groups-list');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    after_id: input.afterId,
    limit: input.limit,
  });
  const result = await tx.query<GroupRow>(query.text, params);
  return result.rows;
}

export async function enabledDevicesTotal(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<number> {
  const query = await loadQuery('groups-enabled-devices-total');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tx.query<{ total: number }>(query.text, params);
  return result.rows[0]?.total ?? 0;
}

export interface GroupCapRow extends Record<string, unknown> {
  warmup_tier: number;
  health_band: string;
  eff_group_daily_cap: number;
  sent_today: number;
}

export async function readGroupCapToday(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<GroupCapRow | undefined> {
  const query = await loadQuery('groups-cap-today');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tx.query<GroupCapRow>(query.text, params);
  return result.rows[0];
}

export interface GroupFullRow extends GroupRow {
  client_id: string;
  left_at: Date | null;
}

/**
 * Locks (`FOR UPDATE`) the tenant's instance row FIRST, inside the caller's
 * transaction - the single serialization point for concurrent `PATCH
 * .../send-enabled` enables against DIFFERENT groups of the SAME instance
 * (P24 C2 fix round, Fix 1: `groups-get.sql`'s per-group lock alone cannot
 * serialize two different group rows). `undefined` covers both "not found"
 * and "another tenant's/deleted instance" (RLS + explicit client_id
 * predicate) - the caller treats that as `GroupInstanceNotFoundError`.
 */
export async function lockInstanceForGroupsEnable(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<string | undefined> {
  const query = await loadQuery('groups-lock-instance');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tx.query<{ id: string }>(query.text, params);
  return result.rows[0]?.id;
}

/** Locks (`FOR UPDATE`) and reads one group row by id - `undefined` covers both "not found" and "another tenant's row" (RLS + explicit client_id predicate). */
export async function getGroupForUpdate(
  tx: TenantQueryable,
  input: { clientId: string; id: string },
): Promise<GroupFullRow | undefined> {
  const query = await loadQuery('groups-get');
  const params = bindQueryParams(query, { client_id: input.clientId, id: input.id });
  const result = await tx.query<GroupFullRow>(query.text, params);
  return result.rows[0];
}

export async function otherEnabledDevicesTotal(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string; id: string },
): Promise<number> {
  const query = await loadQuery('groups-other-enabled-devices-total');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
    id: input.id,
  });
  const result = await tx.query<{ total: number }>(query.text, params);
  return result.rows[0]?.total ?? 0;
}

/** Conditional UPDATE flipping `send_enabled` - `undefined` means zero rows matched (foreign/missing/left row). */
export async function setSendEnabled(
  tx: TenantQueryable,
  input: { clientId: string; id: string; enable: boolean; userId: string },
): Promise<GroupRow | undefined> {
  const query = await loadQuery('groups-set-send-enabled');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    id: input.id,
    enable: input.enable,
    user_id: input.userId,
  });
  const result = await tx.query<GroupRow>(query.text, params);
  return result.rows[0];
}

/** Conditional UPDATE requesting a leave - `undefined` means either a genuinely missing/left row, or an already-pending leave (the caller falls back to `readLeaveRequestedAt`). */
export async function requestLeave(
  tx: TenantQueryable,
  input: { clientId: string; id: string },
): Promise<Date | undefined> {
  const query = await loadQuery('groups-request-leave');
  const params = bindQueryParams(query, { client_id: input.clientId, id: input.id });
  const result = await tx.query<{ leave_requested_at: Date }>(query.text, params);
  return result.rows[0]?.leave_requested_at;
}

/** The idempotent-replay read: the existing `leave_requested_at` on a still-live (not left) row, or `undefined` if the id is foreign/missing/already left. */
export async function readLeaveRequestedAt(
  tx: TenantQueryable,
  input: { clientId: string; id: string },
): Promise<Date | null | undefined> {
  const query = await loadQuery('groups-get-leave-requested-at');
  const params = bindQueryParams(query, { client_id: input.clientId, id: input.id });
  const result = await tx.query<{ leave_requested_at: Date | null }>(query.text, params);
  if (result.rows.length === 0) {
    return undefined;
  }
  return result.rows[0]!.leave_requested_at;
}

/** `GROUP_SYNC_MIN_INTERVAL_MS` re-exported for `sync.ts`'s own `groups-sync-complete` bind - kept in this repo file so both callers derive it from the ONE `@wp/domain` constant, never a second hand-copied literal. */
export const SYNC_MIN_INTERVAL_MS = GROUP_SYNC_MIN_INTERVAL_MS;

export interface SyncClockRow extends Record<string, unknown> {
  groups_sync_requested_at: Date;
  groups_next_sync_after: Date | null;
}

/** Conditional UPDATE requesting a group sync - `undefined` means zero rows matched (foreign/missing/deleted instance, or a genuine rate-limit refusal; the caller falls back to `readGroupsSyncClock`). */
export async function requestGroupSync(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<SyncClockRow | undefined> {
  const query = await loadQuery('groups-request-sync');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tx.query<SyncClockRow>(query.text, params);
  return result.rows[0];
}

/** The rate-limit read-fallback: `undefined` means a genuinely foreign/missing/deleted instance (404); a row's `groups_next_sync_after` tells the caller whether the refusal was in-window. */
export async function readGroupsSyncClock(
  tx: TenantQueryable,
  input: { clientId: string; instanceId: string },
): Promise<{ groups_next_sync_after: Date | null } | undefined> {
  const query = await loadQuery('groups-sync-clock');
  const params = bindQueryParams(query, {
    client_id: input.clientId,
    instance_id: input.instanceId,
  });
  const result = await tx.query<{ groups_next_sync_after: Date | null }>(query.text, params);
  return result.rows[0];
}
