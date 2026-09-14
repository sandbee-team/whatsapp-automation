import { DENY_REASON_EFFECTS, isExemptOrigin, type DenyReason, type SendOrigin } from '@wp/domain';
import type { TenantQueryable } from '@wp/db';
import {
  ensureDailyUsageRow,
  ensurePacingLedgerRow,
  pacingDenyReason,
  releasePacing,
  reservePacing,
  type PacingQueryable,
} from '../../modules/pacing/pacing.repo.js';
import { notify } from '../../modules/notifications/index.js';
import { resolveRetryAt, type Clock } from './retry-at.js';
import { bindPacingMetrics } from './metrics.js';

/**
 * engine/pacing/index.ts (P13 Unit U4, step 7) - `reserve()`/`release()`,
 * the two entry points `send-loop.ts` wires into the claim transaction.
 * `reserve()` runs `db/queries/reserve-pacing.sql`; on a deny (zero rows)
 * it follows up with `db/queries/pacing-deny-reason.sql` and resolves the
 * returned `RetryAtRule` (`@wp/domain`'s `DENY_REASON_EFFECTS`) into a
 * concrete `next_attempt_at` via `resolveRetryAt` (this module's sibling,
 * `retry-at.ts` - the clock/timezone live here, never in `packages/domain`).
 *
 * ORDER (send-loop.ts's own requirement, P11's insertion-point comment):
 * claim -> reserve() -> dispatch, all inside ONE transaction. Zero rows
 * from EITHER claim or reserve rolls the WHOLE transaction back - no
 * compensating `release()` call for a losing claim race. `release()` is for
 * POST-COMMIT outcomes only (see `release-pacing.sql`'s own header) -
 * never called from inside the claim+reserve transaction.
 *
 * A deny NEVER touches `attempts` and NEVER fails the job - it writes
 * `message_jobs.status='queued', next_attempt_at=<resolved>` (the SAME
 * requeue-for-retry columns migration 0025 already grants `wp_scheduler`)
 * and, for `UNKNOWN` specifically, this is a fail-closed 60s hold + alert
 * (`DENY_REASON_EFFECTS.UNKNOWN`), never a grant.
 *
 * NO RETRY (FINDING 5 FIX, P13 C1 review - this module previously retried
 * once on a first-reserve `NO_LEDGER_ROW`/`UNKNOWN` deny, to paper over an
 * MVCC-snapshot problem in `reserve-pacing.sql`'s own now-deleted `ins`/
 * `cu` CTEs; see that file's own header, point (8), for the full former
 * failure shape). `reserve()` now runs `ensurePacingLedgerRow` +
 * `ensureDailyUsageRow` as their OWN statements, in the same transaction,
 * immediately before `reservePacing` - by the time `reservePacing` itself
 * runs, both rows are already visible on an ordinary base-table scan (fresh
 * statement, fresh snapshot), so a genuine first reserve of an
 * (instance, local day) grants on the FIRST attempt, always. `UNKNOWN`
 * therefore regains its literal fail-closed-and-alert contract meaning
 * (`DENY_REASON_EFFECTS.UNKNOWN`) - every named predicate passing yet the
 * reserve still returning zero rows is now a genuine contradiction worth
 * alerting on, never silently retried first.
 */

export interface PacingDenial {
  granted: false;
  reason: DenyReason;
  retryAt: Date;
  alerting: boolean;
}

export interface PacingGrant {
  granted: true;
  ledgerDate: string;
  nextEligibleAt: Date;
}

export type PacingReserveOutcome = PacingGrant | PacingDenial;

export interface ReserveInput {
  sql: PacingQueryable;
  clientId: string;
  instanceId: string;
  isNewConversation: boolean;
  isGroup: boolean;
  gapMs: number;
  /** `message_jobs.send_origin` (P14 Unit U4) - defaults to `'api_send'` (a NON-exempt origin) when the claimed job predates this column (null on a pre-P14 row). `isExemptOrigin()` (`@wp/domain`) derives `$is_exempt` from this - never bound directly by the caller. */
  sendOrigin?: SendOrigin | null;
  clock: Clock;
  /** `instance_pacing_state.pacing_timezone` - required to resolve `nextLocalMidnight`/`nextWindowOpen` on a deny. Callers read this in the same transaction (see wiring note in send-loop.ts). */
  timeZone: string;
  /** `instance_pacing_state.eff_window_start_local` - required only for `OUTSIDE_WINDOW`/`PER_RECIPIENT_FREQ` denials. */
  windowStartLocal?: string;
  /** `instance_pacing_state.eff_window_end_local` - required only for `OUTSIDE_WINDOW`/`PER_RECIPIENT_FREQ` denials, to detect "already inside today's window" (see `retry-at.ts#nextWindowOpenMs`'s own doc comment). */
  windowEndLocal?: string;
}

/**
 * Attempts to reserve one pacing unit. Runs `ensurePacingLedgerRow` +
 * `ensureDailyUsageRow` (zero-valued row creation, same transaction,
 * immediately before - see this module's own doc, "NO RETRY"), then
 * `reserve-pacing.sql` itself; on zero rows, follows up with
 * `pacing-deny-reason.sql` (same `sql` executor, same transaction) to name
 * the reason and resolve a concrete retry time. Never throws for "denied" -
 * a denial is `{granted: false, ...}`, a normal outcome the caller
 * (send-loop.ts) writes back onto the job. Never retries.
 *
 * Wrapped end-to-end (ledger/usage row ensures + the reserve statement
 * itself, plus the deny-reason follow-up on a denial) by
 * `wp_pacing_reserve_seconds` (`engine/pacing/metrics.ts`, no label).
 */
/**
 * The tenant-local calendar date (`YYYY-MM-DD`) for `epochMs` in `timeZone` -
 * mirrors `pacing-deny-reason.sql`'s own `ledger_date` derivation
 * (`(now() AT TIME ZONE pacing_timezone)::date`), computed in JS via `Intl`
 * (never a Node-computed UTC date - `retry-at.ts`'s own `localDateParts` doc
 * comment documents why fixed-offset arithmetic is wrong across DST; this is
 * the same technique, kept local to this module since `retry-at.ts` has no
 * exported string-bucket helper to reuse). Used ONLY to build the
 * `plan_cap_reached` notify's `bucket` (its `dedupeScope` is `'instance-day'`
 * - `@wp/domain`'s `kinds.ts`).
 */
function tenantLocalDateBucket(epochMs: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date(epochMs));
}

export async function reserve(input: ReserveInput): Promise<PacingReserveOutcome> {
  const endTimer = bindPacingMetrics().reserveSeconds.startTimer();
  try {
    return await reserveTimed(input);
  } finally {
    endTimer();
  }
}

async function reserveTimed(input: ReserveInput): Promise<PacingReserveOutcome> {
  await ensurePacingLedgerRow(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
  });
  await ensureDailyUsageRow(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
  });

  const isExempt = isExemptOrigin(input.sendOrigin ?? 'api_send');
  const granted = await reservePacing(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    isNewConversation: input.isNewConversation,
    gapMs: input.gapMs,
    isGroup: input.isGroup,
    isExempt,
  });

  if (granted) {
    return {
      granted: true,
      ledgerDate: granted.ledgerDate,
      nextEligibleAt: granted.nextEligibleAt,
    };
  }

  const denyRow = await pacingDenyReason(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    isNewConversation: input.isNewConversation,
    isGroup: input.isGroup,
    isExempt,
  });
  const effect = DENY_REASON_EFFECTS[denyRow.reason];
  const retryAt = resolveRetryAt({
    rule: effect.retryAtRule,
    clock: input.clock,
    timeZone: input.timeZone,
    nextEligibleAt: denyRow.retryAt,
    windowStartLocal: input.windowStartLocal,
    windowEndLocal: input.windowEndLocal,
  });

  // P17 U6 (step 5) - plan_cap_reached: mandatory notify on the SAME `sql`
  // handle as the claim+reserve deny above (the caller's own claim
  // transaction, `send-loop-claim-evaluation.ts`). dedupeScope is
  // 'instance-day' (kinds.ts) - bucket = the tenant-local date the deny
  // itself is scoped to (mirrors `pacing-deny-reason.sql`'s own
  // `ledger_date`); transitionId is the literal 'plan-cap' (task's own
  // instruction, verbatim) since the (instance, bucket) pair alone already
  // makes this dedupe key unique per instance per day.
  if (denyRow.reason === 'PLAN_CAP') {
    await notify(input.sql as unknown as TenantQueryable, {
      clientId: input.clientId,
      instanceId: input.instanceId,
      kind: 'plan_cap_reached',
      transitionId: 'plan-cap',
      bucket: tenantLocalDateBucket(input.clock.now(), input.timeZone),
      payload: { instanceId: input.instanceId },
    });
  }

  return { granted: false, reason: denyRow.reason, retryAt, alerting: effect.alerting };
}

export interface ReleaseInput {
  sql: PacingQueryable;
  clientId: string;
  instanceId: string;
  /** `message_jobs.pacing_ledger_date` from the ORIGINAL reserve - never `now()`, never caller-supplied "today" (see `release-pacing.sql`'s own header). */
  ledgerDate: string;
  messageJobId: string;
  /** Must be the ORIGINAL reserve's bind values, read back from the job's own stored classification - never re-derived. */
  isNewConversation: boolean;
  isGroup: boolean;
  /** Must be the ORIGINAL reserve's `isExempt` bind value (`isExemptOrigin(sendOrigin)`), read back from the job's own stored classification - never re-derived (Finding 9, P14 review-fix F2). Selects the exempt refund branch (`system_count`, no `next_eligible_at` restore) vs. the non-exempt branch. */
  isExempt: boolean;
  /** Must be the ORIGINAL reserve's `gapMs` bind value. Ignored by `release-pacing.sql` when `isExempt` is true (an exempt reserve never advanced `next_eligible_at`). */
  gapMs: number;
}

export interface ReleaseOutcome {
  /** `false` when the job was already refunded (or never reserved) - a normal, idempotent no-op. */
  refunded: boolean;
}

/**
 * Refunds a previously-reserved pacing unit for a job whose provider
 * outcome is now known to be a non-attempt (see `release-pacing.sql`'s own
 * header for the exact allowed outcome classes - PROVIDER_ATTEMPTED is
 * structurally unrefundable, this function has no `outcome` parameter at
 * all). POST-COMMIT only - never called from inside an in-flight claim
 * transaction that is about to roll back.
 */
export async function release(input: ReleaseInput): Promise<ReleaseOutcome> {
  const row = await releasePacing(input.sql, {
    clientId: input.clientId,
    instanceId: input.instanceId,
    ledgerDate: input.ledgerDate,
    messageJobId: input.messageJobId,
    isNewConversation: input.isNewConversation,
    isGroup: input.isGroup,
    isExempt: input.isExempt,
    gapMs: input.gapMs,
  });
  return { refunded: row !== undefined };
}
