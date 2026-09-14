import type { TenantDb } from '@wp/db';
import { TIMING } from '@wp/domain';
import type { ObjectStore } from '../../platform/storage/object-store.js';
import type {
  MessageTransport,
  SendOutcome,
  WaMessagePayload,
} from '../../provider/provider.types.js';
import { resolveMediaOrDefer, touchMediaLastUsedBestEffort } from './dispatch-media.js';
import {
  refundPacingUnitAfterPrecheckCancel,
  runPrecheckAndPrepare,
} from './dispatch-optout-precheck.js';
import { prepareAndIncrement, type DispatchInput } from './dispatch-prepare.js';

// Re-exported so this module's public surface stays unchanged (both live in
// dispatch-prepare.ts - max-lines split / import-boundary reasons, same
// idiom as result.ts's own re-exports from its sibling files).
export {
  ClaimLostBeforeDispatch,
  DispatchAlreadyRecorded,
  type DispatchInput,
} from './dispatch-prepare.js';

/** Minimal clock port - injected, never `Date.now()` directly. */
export interface Clock {
  now(): number;
}

/**
 * dispatch.ts (P11 Unit U4, step 6) - the blueprint's normative pseudocode,
 * verbatim order:
 *
 *   1. ONE transaction: pre-send opt-out precheck (P14, see
 *      `dispatch-optout-precheck.ts`) -> INSERT send_attempts
 *      (state='prepared') + UPDATE message_jobs SET attempts = attempts +
 *      1 + INSERT delivery_events ('dispatched'). COMMIT. A precheck
 *      cancellation short-circuits this whole step (no attempt row).
 *   2. Outside that transaction: UPDATE send_attempts SET
 *      state='dispatched', dispatched_at=now(); await transport.send(...)
 *      under a hard TIMING.sendTimeoutMs timeout, with a lease heartbeat
 *      renewing message_jobs.lease_expires_at for the whole flight.
 *
 * `send_attempts` is written BEFORE the provider call, never after (a crash
 * after send and before the attempt row is an undetectable duplicate). A
 * send timeout is `dispatched`/unknown, never a retry decision made HERE -
 * only result.ts (step 7) classifies an outcome and requeues/pauses/fails.
 *
 * PACING (P13/P14): the real durable pacing reserve (`engine/pacing/
 * index.ts#reserve()`) runs inside the SAME transaction as the claim,
 * strictly BEFORE `dispatch()` - by the time this function runs a unit is
 * already reserved. `dispatch()` gates on nothing pacing-related itself
 * except the P14 precheck cancellation, which refunds that unit post-commit
 * (`refundPacingUnitAfterPrecheckCancel`).
 *
 * EVERY `message_jobs` WHERE predicate in this file matches on `id` ALONE
 * (never `created_at`): `message_jobs.created_at` never leaves Postgres and
 * comes back as a JS `Date` before being re-bound into a LATER, separate
 * round trip without silently losing microsecond precision (verified live -
 * `messages.repo.ts`'s own header has the same finding). `id` is
 * `GENERATED ALWAYS AS IDENTITY`, globally unique on its own, so it alone
 * still identifies exactly one row.
 */

export interface DispatchDeps {
  tenantDb: TenantDb;
  transport: MessageTransport;
  clock: Clock;
  sendTimeoutMs?: number;
  /** Interval between lease-heartbeat renewals in flight. Defaults to a quarter of TIMING.claimExpiryMs. */
  heartbeatIntervalMs?: number;
  /** Narrow injected callback fired synchronously, immediately before `ClaimLostBeforeDispatch` throws - same port shape as `result.ts`'s `ResultDeps.onClaimLost` (never import metrics into this file directly). */
  onClaimLost?: () => void;
  /** Required only for an `image`/`document` job (`payloadKind === 'media'`) - `dispatch-media.ts#resolveTransportMediaPayload` resolves `mediaId -> getStream(storageKey)` through this port. */
  objectStore?: ObjectStore;
}

export interface DispatchResult {
  attemptNo: number;
  /**
   * `'cancelled_pre_send'` (P14) - the precheck found the recipient opted out
   * AFTER claim but BEFORE any `send_attempts` row: cancelled (not failed) in
   * the same transaction, pacing unit refunded post-commit.
   * `'deferred_media_unavailable'` (P34, ADR 0052 item 5) - the media asset
   * was missing/foreign or the object store failed; the job was deferred
   * (`defer-job.sql`, `attempts` NOT incremented) BEFORE any `send_attempts`
   * row was ever written. `send-loop.ts#dispatchAndResolve` treats BOTH the
   * same way: done, no `resolveAck`/`resolveFailure` call.
   */
  outcome: 'settled' | 'timed_out' | 'cancelled_pre_send' | 'deferred_media_unavailable';
  sendOutcome?: SendOutcome;
  sendError?: unknown;
}

async function markDispatched(
  tenantDb: TenantDb,
  input: DispatchInput,
  attemptNo: number,
): Promise<void> {
  await tenantDb.withTenant(input.clientId, async (tx) => {
    await tx.query(
      `UPDATE send_attempts SET state = 'dispatched', dispatched_at = now()
        WHERE message_job_id = $1 AND attempt_no = $2 AND client_id = $3`,
      [input.jobId, attemptNo, input.clientId],
    );
  });
}

function startHeartbeat(tenantDb: TenantDb, input: DispatchInput, intervalMs: number): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void tenantDb
      .withTenant(input.clientId, (tx) =>
        tx.query(
          `UPDATE message_jobs SET lease_expires_at = now() + (${String(TIMING.claimExpiryMs)} * interval '1 ms')
            WHERE id = $1 AND lease_id = $2 AND status = 'processing' AND client_id = $3`,
          [input.jobId, input.leaseId, input.clientId],
        ),
      )
      .catch(() => {
        // Non-fatal: if the lease genuinely expires, the reaper (P12)
        // repairs the job - this only tries to keep it alive.
      });
  };
  const handle = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Runs steps 1-2 above. Resolves once the provider call settles OR the hard
 * send timeout elapses - a timeout resolves `{outcome: 'timed_out'}` rather
 * than rejecting, since a timeout is `dispatched`/unknown, never a retry
 * decision made here (result.ts's caller decides what a timeout means).
 */
export async function dispatch(input: DispatchInput, deps: DispatchDeps): Promise<DispatchResult> {
  const attemptNo = input.attempts + 1;

  // Media resolve (P34, ADR 0052 item 5) runs FIRST, BEFORE the precheck/
  // prepareAndIncrement transaction - a defer must leave `attempts`
  // untouched and no `send_attempts` row, so the resolve must fail closed
  // before either is ever written, never after (dispatch-media.ts owns the
  // resolve-or-defer branching itself - max-lines discipline).
  let mediaPayload: WaMessagePayload | undefined;
  if (input.payloadKind === 'media') {
    const resolved = await resolveMediaOrDefer(
      deps.tenantDb,
      deps.objectStore,
      { ...input, recipientJid: input.recipientJid, payload: input.payload },
      deps.clock.now(),
    );
    if (resolved.deferred) {
      return { attemptNo, outcome: 'deferred_media_unavailable' };
    }
    mediaPayload = resolved.payload;
  }

  // `input` structurally satisfies OptOutPrecheckInput (superset) - passed directly.
  const { cancelled } = await deps.tenantDb.withTenant(input.clientId, (tx) =>
    runPrecheckAndPrepare(tx, input, () =>
      prepareAndIncrement(tx, input, attemptNo, deps.onClaimLost),
    ),
  );

  if (cancelled) {
    await refundPacingUnitAfterPrecheckCancel(deps.tenantDb, input, input.pacingReserve);
    return { attemptNo, outcome: 'cancelled_pre_send' };
  }

  await markDispatched(deps.tenantDb, input, attemptNo);

  const sendTimeoutMs = deps.sendTimeoutMs ?? TIMING.sendTimeoutMs;
  const heartbeatIntervalMs = deps.heartbeatIntervalMs ?? Math.floor(TIMING.claimExpiryMs / 4);
  const stopHeartbeat = startHeartbeat(deps.tenantDb, input, heartbeatIntervalMs);

  const msg: WaMessagePayload = mediaPayload ?? {
    to: input.recipientJid,
    kind: 'text',
    text: String(input.payload.text ?? ''),
  };

  // Fire-and-forget `last_used_at` stamp (ADR 0052 item 5/7) - never awaited
  // into the send's own critical path, a failure here must never fail a send.
  if (mediaPayload && typeof input.payload.mediaId === 'string') {
    void touchMediaLastUsedBestEffort(deps.tenantDb, input.clientId, input.payload.mediaId);
  }

  let timedOut = false;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      timedOut = true;
      reject(new Error('dispatch: send timed out'));
    }, sendTimeoutMs);
  });

  try {
    const sendOutcome = await Promise.race([
      deps.transport.send(input.instanceId, msg),
      timeoutPromise,
    ]);
    return { attemptNo, outcome: 'settled', sendOutcome };
  } catch (err) {
    if (timedOut) {
      return { attemptNo, outcome: 'timed_out' };
    }
    return { attemptNo, outcome: 'settled', sendError: err };
  } finally {
    stopHeartbeat();
  }
}
