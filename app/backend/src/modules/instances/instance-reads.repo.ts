import { bindQueryParams, loadQuery } from '@wp/db';
import type { InstanceCtx } from './repo.js';

/**
 * instance-reads.repo.ts (P08 Unit U6c) - client-scoped, SELECT-only reads
 * for the instance link/park routes (`instances.routes.ts`): the
 * link-status projection, the registered/connected-instance counters, the
 * online-holders list, and the plan-limits read. Split out of `repo.ts`
 * (max-lines discipline) rather than folded in - `repo.ts`'s own header
 * comment already documents its two write families (TENANT-ACTION /
 * ENGINE); these are a third, read-only family that does not fit either,
 * so a sibling file keeps that document accurate rather than stretched.
 */

interface LinkStatusRow extends Record<string, unknown> {
  link_state: string;
  health_state: string;
  desired_state: string;
  needs_user_action: boolean;
  user_action_reason: string | null;
  qr_attempts: number;
  phone_e164: string | null;
}

export interface LinkStatus {
  linkState: string;
  healthState: string;
  desiredState: string;
  needsUserAction: boolean;
  userActionReason: string | null;
  qrAttempts: number;
  phoneE164: string | null;
}

/** Client-scoped read for `GET /v1/instances/:id/link-status` - `null` covers "not found"/"already deleted" (the route maps that to 404). */
export async function readLinkStatus(
  ctx: InstanceCtx,
  instanceId: string,
): Promise<LinkStatus | null> {
  const query = await loadQuery('instance-link-status');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<LinkStatusRow>(query.text, params);
  const row = result.rows[0];
  if (!row) return null;
  return {
    linkState: row.link_state,
    healthState: row.health_state,
    desiredState: row.desired_state,
    needsUserAction: row.needs_user_action,
    userActionReason: row.user_action_reason,
    qrAttempts: row.qr_attempts,
    phoneE164: row.phone_e164,
  };
}

interface CountRow extends Record<string, unknown> {
  count: number;
}

/** Counts this client's non-deleted instances - the registered-instance cap check for `POST /v1/instances`. */
export async function countRegisteredInstances(ctx: InstanceCtx): Promise<number> {
  const query = await loadQuery('instance-count-registered');
  const params = bindQueryParams(query, { client_id: ctx.clientId });
  const result = await ctx.sql.query<CountRow>(query.text, params);
  return result.rows[0]?.count ?? 0;
}

/** Counts this client's non-deleted, currently-online instances - the connected-slot cap check for `POST /v1/instances/:id/online`. */
export async function countOnlineInstances(ctx: InstanceCtx): Promise<number> {
  const query = await loadQuery('instance-count-online');
  const params = bindQueryParams(query, { client_id: ctx.clientId });
  const result = await ctx.sql.query<CountRow>(query.text, params);
  return result.rows[0]?.count ?? 0;
}

interface OnlineHolderRow extends Record<string, unknown> {
  id: string;
  label: string | null;
  phone_e164: string | null;
}

export interface OnlineHolder {
  instanceId: string;
  label: string | null;
  phoneE164: string | null;
}

/** Lists this client's currently-online instances - the holders named in a 409 NO_FREE_SLOT response. */
export async function listOnlineHolders(ctx: InstanceCtx): Promise<OnlineHolder[]> {
  const query = await loadQuery('instance-list-online-holders');
  const params = bindQueryParams(query, { client_id: ctx.clientId });
  const result = await ctx.sql.query<OnlineHolderRow>(query.text, params);
  return result.rows.map((row) => ({
    instanceId: row.id,
    label: row.label,
    phoneE164: row.phone_e164,
  }));
}

export interface PlanLimits {
  maxRegisteredInstances: number;
  maxConnectedInstances: number;
}

interface PlanLimitsRow extends Record<string, unknown> {
  max_registered_instances: number;
  max_connected_instances: number;
}

/** Reads the calling client's own `plan_limits` row - `null` when the client has no plan assigned (caller fails closed, see instance-plan-limits.sql). */
export async function readPlanLimits(ctx: InstanceCtx): Promise<PlanLimits | null> {
  const query = await loadQuery('instance-plan-limits');
  const params = bindQueryParams(query, { client_id: ctx.clientId });
  const result = await ctx.sql.query<PlanLimitsRow>(query.text, params);
  const row = result.rows[0];
  if (!row) return null;
  return {
    maxRegisteredInstances: row.max_registered_instances,
    maxConnectedInstances: row.max_connected_instances,
  };
}

interface SweepTeardownStatusRow extends Record<string, unknown> {
  id: string;
  desired_state: string;
  deleted_at: Date | null;
}

export interface SweepTeardownStatus {
  instanceId: string;
  desiredState: string;
  deletedAt: Date | null;
}

/**
 * Batched, CLIENT-scoped read (P08 FIX BATCH A, A9; FIX ROUND 2 FIX 1) - ONE
 * statement per scan tick, per client, across every instance id the caller
 * currently holds a registry handle for THAT client, replacing an O(N)
 * per-held-session `readLinkStatus` loop. Client-scoped (takes an
 * `InstanceCtx`, not a bare queryable) because `whatsapp_instances` has
 * FORCE ROW LEVEL SECURITY keyed on `app.client_id` and the worker role
 * `wp_app` does not bypass it - an unscoped read under that role silently
 * returns zero rows in production (see
 * `instance-sweep-teardown-status.sql`'s own header comment). An id absent
 * from the result (already hard-deleted, or never existed for this client)
 * is simply missing from the returned array - the caller (`sweepTeardowns`)
 * fails CLOSED on any short read: a missing id is treated as "keep it",
 * never "ineligible", unless a row is positively present proving
 * ineligibility.
 */
export async function readSweepTeardownStatuses(
  ctx: InstanceCtx,
  instanceIds: readonly string[],
): Promise<SweepTeardownStatus[]> {
  if (instanceIds.length === 0) {
    return [];
  }
  const query = await loadQuery('instance-sweep-teardown-status');
  const params = bindQueryParams(query, { instance_ids: instanceIds, client_id: ctx.clientId });
  const result = await ctx.sql.query<SweepTeardownStatusRow>(query.text, params);
  return result.rows.map((row) => ({
    instanceId: row.id,
    desiredState: row.desired_state,
    deletedAt: row.deleted_at,
  }));
}
