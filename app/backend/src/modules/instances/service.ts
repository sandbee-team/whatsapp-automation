import type { EncryptedAuthStore } from '../../provider/baileys/auth-state/types.js';
import { provisioningRepo } from '../tenancy/index.js';
import type { TenantQueryable } from '@wp/db';
import type { PauseReason, Transition, WaHealth } from '@wp/domain';
import { notify } from '../notifications/index.js';
import * as repo from './repo.js';
import type { EngineWriteMeta, InstanceCtx } from './repo.js';

/**
 * service.ts (P08 Unit U4) - consumes the `@wp/domain` session FSM
 * (`applyDisconnect`/`beginPairing`/`pairingSucceeded`/`pairingExpired`) and
 * drives `repo.ts`'s writes. EVERY transition out of `health_state
 * 'connected'` inserts ONE `audit_logs` row in the SAME client scope
 * (`modules/tenancy/provisioning.repo.ts`'s `insertAuditLog`, the same
 * writer `identity`'s lockout audit uses) - actor `'system'` for engine
 * transitions, `'user'` + `actorUserId` for tenant actions.
 *
 * LOGGED-OUT FLOW ORDERING (crash-window, documented per the task): (1) the
 * fence-guarded `markLoggedOut` write lands FIRST, (2) `authStore.purge(fence)`
 * runs SECOND. A crash between the two leaves the instance already marked
 * `logged_out`/`unlinked`/`RELINK_REQUIRED` with its auth material still
 * present - safe, because P07's `purge` is itself idempotent (a replay purge
 * is a benign no-op, `PurgeResult.purged: false`) and a `logged_out` instance
 * is never re-claimed by the engine (no new lease is minted for a logged-out
 * instance), so a retried `purge` call for the SAME fence is always safe to
 * run again later. The reverse order (purge-first) would instead risk a
 * crash window where auth material is gone but the instance still LOOKS
 * connected/degraded - a worse fail-open state - so state-first is the
 * deliberate choice, not an accident of implementation order.
 */

const HEALTH_TO_AUDIT_ACTION: Partial<Record<WaHealth, string>> = {
  degraded: 'instance.degraded',
  paused: 'instance.paused',
  logged_out: 'instance.logged_out',
};

/** Every `UserActionReason` this FSM can produce maps to exactly one `PauseReason` label for the audit row / `pause_reason` column. */
const USER_ACTION_REASON_TO_PAUSE_REASON: Record<string, PauseReason> = {
  PAIRING_EXPIRED: 'pairing_expired',
  RECONNECT_FAILED: 'reconnect_failed',
  RESTRICTION_SIGNAL: 'provider_restriction',
  SESSION_REPLACED: 'session_replaced',
  RELINK_REQUIRED: 'user_action',
  INFRA_UNAVAILABLE: 'unknown_signal',
};

function pauseReasonFor(userActionReason: string | null | undefined): PauseReason | null {
  if (!userActionReason) return null;
  return USER_ACTION_REASON_TO_PAUSE_REASON[userActionReason] ?? 'unknown_signal';
}

export interface ApplyEngineTransitionMeta {
  code?: string;
  reasonLabel?: string;
  fence: bigint | number;
  workerId: string;
}

export interface InstanceServiceDeps {
  ctx: InstanceCtx;
  /** Also used as the `TenantQueryable` for the audit-log insert - same connection/transaction scope as `ctx.sql`. */
  auditSql: TenantQueryable;
}

/**
 * Applies a domain `Transition` produced by `applyDisconnect` (or any other
 * FSM entry point) to `whatsapp_instances`, via the correct fence-guarded
 * engine-write statement, then writes the ONE audit row every transition out
 * of `'connected'` requires. `meta.code`/`meta.reasonLabel` land in
 * `disconnection_reason_code`/`disconnection_reason_label` - the runner
 * (next unit) maps a raw Baileys code to these; this service never inspects
 * a raw disconnect code itself.
 */
export async function applyEngineTransition(
  deps: InstanceServiceDeps,
  instanceId: string,
  fromHealth: WaHealth,
  transition: Transition,
  meta: ApplyEngineTransitionMeta,
): Promise<void> {
  const engineMeta: EngineWriteMeta = {
    instanceId,
    fence: meta.fence,
    workerId: meta.workerId,
  };

  const healthState = transition.healthState ?? fromHealth;
  await repo.applyTransitionWrite(deps.ctx, {
    ...engineMeta,
    healthState,
    linkState: transition.linkState ?? null,
    needsUserAction: transition.needsUserAction ?? false,
    userActionReason: transition.userActionReason ?? null,
    pauseReason: pauseReasonFor(transition.userActionReason),
    disconnectionReasonCode: meta.code ?? null,
    disconnectionReasonLabel: meta.reasonLabel ?? null,
  });

  await writeTransitionAuditIfLeavingConnected(deps, instanceId, fromHealth, transition, meta);
}

async function writeTransitionAuditIfLeavingConnected(
  deps: InstanceServiceDeps,
  instanceId: string,
  fromHealth: WaHealth,
  transition: Transition,
  meta: ApplyEngineTransitionMeta,
): Promise<void> {
  if (fromHealth !== 'connected') return;
  const toHealth = transition.healthState ?? fromHealth;
  const action = HEALTH_TO_AUDIT_ACTION[toHealth] ?? 'instance.transitioned';

  await provisioningRepo.insertAuditLog(deps.auditSql, {
    clientId: deps.ctx.clientId,
    actorType: 'system',
    action,
    targetType: 'instance',
    targetId: instanceId,
    metadata: {
      reason: transition.userActionReason ?? null,
      code: meta.code ?? null,
    },
  });

  // P17 U6 (step 5) - reconnect_budget_exhausted: mandatory notify on the
  // SAME tx, only for the RECONNECT_FAILED transition (runner-disconnect.ts's
  // give-up branch). transitionId = the lease fence this write ran under -
  // stable, non-wall-clock, and unique per lease acquisition (a fence is
  // minted once per lease grant and this give-up write only ever fires once
  // for that lease, so a retried/duplicated call under the SAME fence
  // dedupes correctly per core invariant 3).
  if (transition.userActionReason === 'RECONNECT_FAILED') {
    await notify(deps.auditSql, {
      clientId: deps.ctx.clientId,
      instanceId,
      kind: 'reconnect_budget_exhausted',
      transitionId: meta.fence.toString(),
      payload: { instanceId },
      requiresUserAction: true,
    });
  }
}

export interface LoggedOutFlowInput {
  instanceId: string;
  fence: bigint | number;
  workerId: string;
  authStore: EncryptedAuthStore;
}

/**
 * The `logged_out` flow: (1) fence-guarded `markLoggedOut`, (2)
 * `authStore.purge(fence)` - see this module's header comment for the
 * crash-window ordering rationale. Writes the `instance.logged_out` audit
 * row after the state write lands (before the purge call - the audit row
 * documents the STATE decision, not the purge outcome, so it must not be
 * lost even if the purge step itself fails).
 */
export async function runLoggedOutFlow(
  deps: InstanceServiceDeps,
  input: LoggedOutFlowInput,
): Promise<void> {
  await repo.markLoggedOut(deps.ctx, {
    instanceId: input.instanceId,
    fence: input.fence,
    workerId: input.workerId,
  });

  await provisioningRepo.insertAuditLog(deps.auditSql, {
    clientId: deps.ctx.clientId,
    actorType: 'system',
    action: 'instance.logged_out',
    targetType: 'instance',
    targetId: input.instanceId,
    metadata: { reason: 'RELINK_REQUIRED', code: null },
  });

  // P17 U6 (step 5) - instance_logged_out: mandatory notify on the SAME tx,
  // right after the state write lands (before the purge call, matching this
  // function's own crash-window ordering doc). transitionId = the lease
  // fence this write ran under (`markLoggedOut`'s own fence predicate) - no
  // synthetic row id is available from that fence-guarded UPDATE, and a
  // fence is minted once per lease acquisition and never reused, so it is
  // the stable, non-wall-clock identity for THIS logged-out transition.
  await notify(deps.auditSql, {
    clientId: deps.ctx.clientId,
    instanceId: input.instanceId,
    kind: 'instance_logged_out',
    transitionId: input.fence.toString(),
    payload: { instanceId: input.instanceId },
    requiresUserAction: true,
  });

  await input.authStore.purge(input.fence);
}

export interface BeginPairingInput {
  instanceId: string;
}

/** TENANT-ACTION: thin pass-through to `repo.beginPairingIntent` - no audit row (pairing INTENT is not a transition out of `'connected'`). */
export async function beginPairing(ctx: InstanceCtx, input: BeginPairingInput): Promise<boolean> {
  return repo.beginPairingIntent(ctx, input.instanceId);
}
