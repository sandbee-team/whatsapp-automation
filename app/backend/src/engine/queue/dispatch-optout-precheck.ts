import type { TenantDb, TenantQueryable } from '@wp/db';
import { isOptedOut } from '../../modules/pacing/optout/registry.js';
import { release } from '../pacing/index.js';

/**
 * dispatch-optout-precheck.ts (P14 Unit U4, step 4) - the pre-send last
 * line of defence: split out of `dispatch.ts` itself purely for that
 * file's max-lines cap (same established split idiom as
 * `send-loop-pacing-claim.ts`/`session-worker-discovery-wiring.ts`).
 *
 * `dispatch()` calls `runOptOutPrecheck` as the FIRST thing inside its own
 * opening `withTenant` transaction, strictly BEFORE the `send_attempts`
 * INSERT (`prepareAndIncrement`'s own work) - a recipient who opted out
 * AFTER this job was claimed (a stale-cache worker, or a race between
 * claim and dispatch) must never reach a real provider call.
 *
 * THREE pass-through shapes, identical to `evaluateOptOutGate`'s own
 * (`modules/pacing/guards/optout-gate.ts`) - this is a SECOND, independent
 * check over the SAME `isOptedOut` lookup, not a competing authority:
 *   - `recipientJid` ends `@g.us` - a group is never opted out.
 *   - `recipientHash === null` - nothing to look up (a pre-P14 row, or a
 *     claim that predates this column being populated).
 *   - `sendOrigin === 'opt_out_confirmation'` - the ONE origin that must
 *     still reach an opted-out contact.
 *
 * A genuine opted-out contact is cancelled IN THE SAME TRANSACTION via a
 * lease-guarded UPDATE (`WHERE lease_id = $lease AND status = 'processing'`
 * - the exact guard shape `dispatch.ts`'s own `prepareAndIncrement` uses
 * for its `attempts + 1` UPDATE): zero rows means another worker's fresh
 * claim already replaced this lease_id (the lease was lost between claim
 * and this precheck) - a normal outcome, `cancelled: false`, never an
 * error. `dispatch.ts` treats that shape the same as any other
 * `ClaimLostBeforeDispatch` case (falls through to the normal dispatch
 * path, which will itself discover the lost lease at the `attempts + 1`
 * UPDATE and throw).
 */

export interface OptOutPrecheckInput {
  clientId: string;
  instanceId: string;
  jobId: string;
  leaseId: string;
  recipientJid: string;
  recipientHash: Buffer | null;
  sendOrigin: string | null;
}

export interface OptOutPrecheckResult {
  /** `true` when the job was cancelled in this call (opted out, lease still held) - `dispatch()` must not proceed to `prepareAndIncrement`. */
  cancelled: boolean;
}

const OPT_OUT_CONFIRMATION_ORIGIN = 'opt_out_confirmation';

/**
 * Runs the pre-send opt-out check against `tx` (the caller's already-open
 * `withTenant` transaction). `deps` is reserved for future injection (kept
 * for call-site symmetry with `dispatch.ts`'s other steps) - currently
 * empty.
 */
export async function runOptOutPrecheck(
  tx: TenantQueryable,
  _deps: Record<string, never>,
  input: OptOutPrecheckInput,
): Promise<OptOutPrecheckResult> {
  const isGroup = input.recipientJid.endsWith('@g.us');
  if (isGroup || input.recipientHash === null || input.sendOrigin === OPT_OUT_CONFIRMATION_ORIGIN) {
    return { cancelled: false };
  }

  const optedOut = await isOptedOut(tx, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    phoneHash: input.recipientHash,
  });
  if (!optedOut) {
    return { cancelled: false };
  }

  // FINDING 8 FIX (P14 review-fix F2): clears the LIVE lease this cancel
  // still holds (lease_owner/lease_id/owner_fence/leased_at/
  // lease_expires_at all NULL, updated_at stamped) - same convention as
  // dispose-job.sql's own terminal write, so a cancelled row never leaves a
  // lease pointing at it. `pacing_reserved_at` is DELIBERATELY NOT cleared
  // here - unlike dispose-job.sql (which runs BEFORE reserve() in
  // claimAndReserve's own ordering, so no unit was ever consumed), this
  // precheck runs AFTER dispatch's own claim+reserve transaction has
  // already committed a real pacing unit for this job. The post-commit
  // refund (`refundPacingUnitAfterPrecheckCancel` -> `release()` ->
  // `release-pacing.sql`) is idempotency-guarded on `message_jobs.
  // pacing_refunded_at IS NULL` alone (never re-checking
  // `pacing_reserved_at`) - clearing `pacing_reserved_at` here would not
  // break that specific guard directly, but would destroy the only durable
  // record that a unit was ever reserved for this job at all, silently
  // making the refund's own precondition unrecoverable if this UPDATE ever
  // needs to be re-derived from the row later. Leave it untouched.
  const cancelResult = await tx.query(
    `UPDATE message_jobs SET status='cancelled', cancel_reason='opt_out',
            pacing_deny_reason='OPT_OUT', terminal_at=now(),
            lease_owner=NULL, lease_id=NULL, owner_fence=NULL,
            leased_at=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE lease_id=$1 AND status='processing' AND id=$2 AND client_id=$3
      -- client_id = $3`,
    [input.leaseId, input.jobId, input.clientId],
  );

  return { cancelled: cancelResult.rowCount === 1 };
}

export interface PrecheckPacingReserve {
  ledgerDate: string;
  gapMs: number;
  isNewConversation: boolean;
  isGroup: boolean;
  /** The ORIGINAL reserve's own `isExempt` bind value (Finding 9, P14 review-fix F2) - threaded through to `release()` unchanged, never re-derived. */
  isExempt: boolean;
}

/**
 * Runs `runOptOutPrecheck`, then - only when it does NOT cancel - the
 * caller-supplied `prepareAndIncrement` step, all inside the SAME open
 * transaction (`dispatch.ts`'s own `withTenant` callback). A cancellation
 * short-circuits: `prepareAndIncrement` never runs at all, so no
 * `send_attempts` row and no `attempts` increment happen for a job this
 * precheck just cancelled. `prepareAndIncrement` is injected (rather than
 * imported here) purely to avoid a circular import between this file and
 * `dispatch.ts` - it stays `dispatch.ts`'s own function, unchanged.
 */
export async function runPrecheckAndPrepare(
  tx: TenantQueryable,
  input: OptOutPrecheckInput,
  prepareAndIncrement: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  const precheck = await runOptOutPrecheck(tx, {}, input);
  if (precheck.cancelled) {
    return { cancelled: true };
  }

  await prepareAndIncrement();
  return { cancelled: false };
}

/**
 * Post-commit refund for a precheck cancellation (`dispatch()`'s own
 * caller, after `runOptOutPrecheck` returned `{cancelled: true}` and that
 * transaction has already committed). `release()` is for post-commit
 * outcomes only (its own doc comment) - this runs in its OWN, separate
 * `withTenant` transaction. A no-op (never throws) when `pacingReserve` is
 * `undefined` - a job that never went through `claimAndReserve` (a pre-P14
 * caller, or a claim-only test) has no unit to refund.
 */
export async function refundPacingUnitAfterPrecheckCancel(
  tenantDb: TenantDb,
  input: { clientId: string; instanceId: string; jobId: string },
  pacingReserve: PrecheckPacingReserve | undefined,
): Promise<void> {
  if (!pacingReserve) return;

  await tenantDb.withTenant(input.clientId, (tx) =>
    release({
      sql: tx,
      clientId: input.clientId,
      instanceId: input.instanceId,
      ledgerDate: pacingReserve.ledgerDate,
      messageJobId: input.jobId,
      isNewConversation: pacingReserve.isNewConversation,
      isGroup: pacingReserve.isGroup,
      isExempt: pacingReserve.isExempt,
      gapMs: pacingReserve.gapMs,
    }),
  );
}
