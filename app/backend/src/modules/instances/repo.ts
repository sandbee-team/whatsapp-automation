import { randomUUID } from 'node:crypto';
import { bindQueryParams, loadQuery } from '@wp/db';
import type { WaLinkState } from '@wp/domain';
import { setInstanceLinkStateGauge } from '../../engine/session/metrics.js';
import { advanceOnboardingAfterLink } from './onboarding-advance-on-link.js';

/**
 * repo.ts (P08 Unit U4) - the canonical, thin repo over `whatsapp_instances`'
 * state-transition statements (see each `db/queries/instance-*.sql` file's
 * own header comment for the invariants it enforces). No ORM
 * re-implementation, no alternative predicate - every fence/tenant rule
 * lives inside the loaded SQL text itself (same discipline as
 * `engine/lease/lease-state-repo.ts`).
 *
 * TWO WRITE FAMILIES (explicit per the phase task):
 *
 *   (a) TENANT-ACTION writes - `createInstance`, `beginPairingIntent`,
 *       `setDesiredState`, `resetPairingWindow`, `softDelete`. Client-scoped
 *       only, no lease/fence predicate: these run from the API, before (or
 *       entirely outside) the engine's lease ownership. `setDesiredState` is
 *       the ONLY place in this schema allowed to change `desired_state` -
 *       callers audit their own use of it (core invariant 6).
 *
 *   (b) ENGINE writes - `markLinkedConnected`, `incrementQrAttempts`,
 *       `markPairingExpired`, `applyTransition`, `markLoggedOut`. Every
 *       statement carries the exact P07 lease predicate family (client +
 *       instance + current_fence + owner_worker_id, all matching) - the
 *       runner holds the lease. ZERO ROWS from ANY engine write is a hard,
 *       typed `StateWriteLostFenceError` - never silent (core invariant 2): a
 *       THROW (PG unavailable) must never be conflated with a statement that
 *       ran and returned zero rows (a fence conflict) - see
 *       `lease-state-repo.ts`'s own header comment for the same distinction.
 */

export interface InstanceQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface InstanceCtx {
  clientId: string;
  sql: InstanceQueryable;
}

/** Thrown by every ENGINE write below when its fence-guarded statement returns zero rows - never silent (core invariant 2). */
export class StateWriteLostFenceError extends Error {
  readonly code = 'state_write_lost_fence' as const;
  constructor(instanceId: string, statement: string) {
    super(`${statement}: instance ${instanceId} is no longer owned at the caller's fence`);
    this.name = 'StateWriteLostFenceError';
  }
}

interface IdRow extends Record<string, unknown> {
  id: string;
}

async function runFenceGuarded(
  ctx: InstanceCtx,
  statement: string,
  input: { instanceId: string; fence: bigint | number; workerId: string },
  params: Readonly<Record<string, unknown>>,
): Promise<void> {
  const query = await loadQuery(statement);
  const bound = bindQueryParams(query, params);
  const result = await ctx.sql.query<IdRow>(query.text, bound);
  if (result.rows.length === 0) {
    throw new StateWriteLostFenceError(input.instanceId, statement);
  }
}

// (a) TENANT-ACTION writes - client-scoped, no fence.

export interface CreateInstanceInput {
  label?: string | null;
}

/** INSERT minimal row RETURNING id - every other column rides its table DEFAULT. */
export async function createInstance(
  ctx: InstanceCtx,
  input: CreateInstanceInput = {},
): Promise<string> {
  const query = await loadQuery('instance-create');
  const id = randomUUID();
  const params = bindQueryParams(query, {
    id,
    client_id: ctx.clientId,
    label: input.label ?? null,
  });
  const result = await ctx.sql.query<IdRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `createInstance: instance-create.sql returned no row for client ${ctx.clientId} - the INSERT ... RETURNING should always return exactly one row`,
    );
  }
  return row.id;
}

/** Starts a fresh pairing intent. Returns whether a row was updated - `false` covers "not found"/"already deleted". */
export async function beginPairingIntent(ctx: InstanceCtx, instanceId: string): Promise<boolean> {
  const query = await loadQuery('instance-begin-pairing');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<IdRow>(query.text, params);
  const updated = result.rows.length > 0;
  if (updated) {
    setInstanceLinkStateGauge({ instanceId, clientId: ctx.clientId, linkState: 'pairing' });
  }
  return updated;
}

/** Explicit human action only (core invariant 6) - callers audit their own use of this. */
export async function setDesiredState(
  ctx: InstanceCtx,
  instanceId: string,
  desiredState: 'online' | 'offline',
): Promise<boolean> {
  const query = await loadQuery('instance-set-desired-state');
  const params = bindQueryParams(query, {
    instance_id: instanceId,
    client_id: ctx.clientId,
    desired_state: desiredState,
  });
  const result = await ctx.sql.query<IdRow>(query.text, params);
  return result.rows.length > 0;
}

interface SessionEpochRow extends Record<string, unknown> {
  session_epoch: number;
  health_state: string;
  link_state: string;
}

export interface ReadSessionEpochResult {
  sessionEpoch: number;
  healthState: string;
  linkState: string;
}

/** Small, client-scoped read of `session_epoch`/`health_state`/`link_state` - no fence predicate (runs before the runner has anything to guard with). Throws if not found for this client - never a default epoch/state. */
export async function readSessionEpoch(
  ctx: InstanceCtx,
  instanceId: string,
): Promise<ReadSessionEpochResult> {
  const query = await loadQuery('instance-read-session-epoch');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<SessionEpochRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `readSessionEpoch: no whatsapp_instances row for instance ${instanceId} in client ${ctx.clientId}`,
    );
  }
  return {
    sessionEpoch: row.session_epoch,
    healthState: row.health_state,
    linkState: row.link_state,
  };
}

/** Retries a still-pairing or pairing-expired window - see instance-reset-pairing-window.sql's own WHERE-clause guard. */
export async function resetPairingWindow(ctx: InstanceCtx, instanceId: string): Promise<boolean> {
  const query = await loadQuery('instance-reset-pairing-window');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<IdRow>(query.text, params);
  return result.rows.length > 0;
}

/** Soft-delete + park (`deleted_at = now()`, `desired_state = 'offline'`) - never a hard DELETE. */
export async function softDelete(ctx: InstanceCtx, instanceId: string): Promise<boolean> {
  const query = await loadQuery('instance-soft-delete');
  const params = bindQueryParams(query, { instance_id: instanceId, client_id: ctx.clientId });
  const result = await ctx.sql.query<IdRow>(query.text, params);
  return result.rows.length > 0;
}

// (b) ENGINE writes - fence-guarded; zero rows => StateWriteLostFenceError.

export interface EngineWriteMeta {
  instanceId: string;
  fence: bigint | number;
  workerId: string;
}

export interface MarkLinkedConnectedInput extends EngineWriteMeta {
  ownerJid: string | null;
  phoneE164: string | null;
}

export async function markLinkedConnected(
  ctx: InstanceCtx,
  input: MarkLinkedConnectedInput,
): Promise<void> {
  await runFenceGuarded(ctx, 'instance-mark-linked-connected', input, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
    owner_jid: input.ownerJid,
    phone_e164: input.phoneE164,
  });
  setInstanceLinkStateGauge({
    instanceId: input.instanceId,
    clientId: ctx.clientId,
    linkState: 'linked',
  });
  // P28 U5 (item 2): own statement - see onboarding-advance-on-link.ts.
  await advanceOnboardingAfterLink(ctx.sql, ctx.clientId);
}

export interface IncrementQrAttemptsResult {
  qrAttempts: number;
  pairingStartedAt: Date | null;
}

interface IncrementQrAttemptsRow extends Record<string, unknown> {
  qr_attempts: number;
  pairing_started_at: Date | null;
}

export async function incrementQrAttempts(
  ctx: InstanceCtx,
  input: EngineWriteMeta,
): Promise<IncrementQrAttemptsResult> {
  const query = await loadQuery('instance-increment-qr-attempts');
  const params = bindQueryParams(query, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
  const result = await ctx.sql.query<IncrementQrAttemptsRow>(query.text, params);
  const row = result.rows[0];
  if (!row) {
    throw new StateWriteLostFenceError(input.instanceId, 'instance-increment-qr-attempts');
  }
  return { qrAttempts: row.qr_attempts, pairingStartedAt: row.pairing_started_at };
}

export async function markPairingExpired(ctx: InstanceCtx, input: EngineWriteMeta): Promise<void> {
  await runFenceGuarded(ctx, 'instance-mark-pairing-expired', input, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
}

export async function markLoggedOut(ctx: InstanceCtx, input: EngineWriteMeta): Promise<void> {
  await runFenceGuarded(ctx, 'instance-mark-logged-out', input, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
  });
  setInstanceLinkStateGauge({
    instanceId: input.instanceId,
    clientId: ctx.clientId,
    linkState: 'unlinked',
  });
}

export interface ApplyTransitionInput extends EngineWriteMeta {
  healthState: string;
  linkState: string | null;
  needsUserAction: boolean;
  userActionReason: string | null;
  pauseReason: string | null;
  disconnectionReasonCode: string | null;
  disconnectionReasonLabel: string | null;
}

export async function applyTransitionWrite(
  ctx: InstanceCtx,
  input: ApplyTransitionInput,
): Promise<void> {
  await runFenceGuarded(ctx, 'instance-apply-transition', input, {
    instance_id: input.instanceId,
    client_id: ctx.clientId,
    fence: input.fence.toString(),
    worker_id: input.workerId,
    health_state: input.healthState,
    link_state: input.linkState,
    needs_user_action: input.needsUserAction,
    user_action_reason: input.userActionReason,
    pause_reason: input.pauseReason,
    disconnection_reason_code: input.disconnectionReasonCode,
    disconnection_reason_label: input.disconnectionReasonLabel,
  });
  if (input.linkState !== null) {
    setInstanceLinkStateGauge({
      instanceId: input.instanceId,
      clientId: ctx.clientId,
      linkState: input.linkState as WaLinkState,
    });
  }
}
